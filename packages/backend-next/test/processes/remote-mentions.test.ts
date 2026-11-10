/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { request } from 'node:http';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiFollowing, MiMeta, MiNote, MiUser, MiUserProfile, MiUserKeypair } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { startRemotePeer, plainActor, deferred } from '../helpers/remote-peer.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import type { DataSource } from 'typeorm';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let peer: Awaited<ReturnType<typeof startRemotePeer>>;
let authorId: string;
const token = 'remote243native1';
const codec = createIdCodec('aidx');
const actors = new Map<string, Record<string, unknown>>();
let gated: string | null = null;
let entered = deferred();
let release = deferred();
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	peer = await startRemotePeer();
	database.config.url = 'http://local.test'; database.config.outboundHttp.proxy = peer.proxy;
	database.config.processes.shutdownTimeoutMs = 10000;
	authorId = codec.newId(Date.now() - 100000);
	const pair = await generateRsaKeyPair();
	await source.getRepository(MiUser).insert({ id: authorId, username: 'author', usernameLower: 'author', token });
	await source.getRepository(MiUserProfile).insert({ userId: authorId });
	await source.getRepository(MiUserKeypair).insert({ userId: authorId, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await source.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	peer.respond(async req => {
		const url = new URL(req.path, peer.origin);
		if (req.method === 'POST') {
			return { body: {} };
		}
		if (url.pathname === '/.well-known/webfinger') {
			const name = url.searchParams.get('resource')!.slice(5).split('@')[0];
			return { type: 'application/jrd+json', body: { links: [{ rel: 'self', href: `${peer.origin}/users/${name}` }] } };
		}
		if (url.pathname === gated) {
			entered.resolve(); await release.promise;
		}
		return actors.has(url.pathname) ? { body: actors.get(url.pathname) } : { status: 404 };
	});
});
afterAll(async () => {
	release.resolve(); await peer?.close(); await source?.destroy(); await database?.close();
});

function register(name: string, patch: Record<string, unknown> = {}) {
	actors.set(`/users/${name}`, plainActor(peer.origin, name, patch));
}

async function post(port: number, input: Record<string, unknown>) {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input }) });
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json() as { createdNote: { id: string; }; }).createdNote;
}

test('cold system and author PEM discovery connects native posting to actual worker delivery, then refreshed follower sharedInbox changes the next destination', async () => {
	const port = await freePort(); database.config.http.port = port; peer.route('local.test', port);
	const config = await configuration(database.config);
	const http = launch('built/entrypoints/http.js', config.path, { MISSKEY_WEBFINGER_USE_HTTP: 'true' });
	const worker = launch('built/entrypoints/worker.js', config.path);
	register('workerpeer');
	try {
		await Promise.all([http.ready, worker.ready]);
		expect(peer.discoveries).toHaveLength(0);
		const created = await post(port, { text: '@workerpeer@remote.test hello', visibility: 'specified' });
		const remote = await source.getRepository(MiUser).findOneByOrFail({ usernameLower: 'workerpeer', host: 'remote.test' });
		const profile = await source.getRepository(MiUserProfile).findOneByOrFail({ userId: remote.id });
		const saved = await source.getRepository(MiNote).findOneByOrFail({ id: created.id });
		expect(saved.mentions).toEqual([remote.id]);
		expect(JSON.parse(saved.mentionedRemoteUsers)).toEqual([{ uri: remote.uri, url: profile.url, username: 'workerpeer', host: 'remote.test' }]);
		await vi.waitFor(() => {
			expect(peer.requests.some(r => r.method === 'POST' && r.body.includes(created.id))).toBe(true);
		}, { timeout: 20000 });
		const received = peer.requests.find(r => r.method === 'POST' && r.body.includes(created.id))!;
		expect(received).toMatchObject({ path: '/inbox/workerpeer', signature: true, digest: true, keyId: `http://local.test/users/${authorId}#main-key` });
		const activity = JSON.parse(received.body);
		expect(activity.type).toBe('Create'); expect(activity.actor).toBe(`http://local.test/users/${authorId}`);
		expect(activity.object.to).toEqual([remote.uri]);
		expect(activity.object.tag).toContainEqual({ type: 'Mention', href: remote.uri, name: '@workerpeer@remote.test' });
		expect(activity.object.content).toContain(profile.url!);
		expect(peer.discoveries.some(d => d.actor.type === 'Application')).toBe(true);
		expect(peer.discoveries.some(d => d.actor.id === `http://local.test/users/${authorId}` && d.actor.type === 'Person')).toBe(true);
		const show = await fetch(`http://127.0.0.1:${port}/api/notes/show`, { method: 'POST', body: JSON.stringify({ i: token, noteId: created.id }) });
		expect(show.status).toBe(200); expect((await show.json() as { text: string; }).text).toBe(saved.text);

		await source.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: remote.id, followeeId: authorId, followerHost: remote.host, followerInbox: remote.inbox, followerSharedInbox: remote.sharedInbox });
		await source.getRepository(MiUser).update(remote.id, { lastFetchedAt: new Date(Date.now() - 86400001) });
		register('workerpeer', { endpoints: { sharedInbox: `${peer.origin}/inbox/refreshed` } });
		const refresh = await post(port, { text: '@workerpeer@remote.test refreshed' });
		expect((await source.getRepository(MiFollowing).findOneByOrFail({ followerId: remote.id })).followerSharedInbox).toBe(`${peer.origin}/inbox/refreshed`);
		await vi.waitFor(() => {
			expect(peer.requests.some(r => r.method === 'POST' && r.path === '/inbox/refreshed' && r.body.includes(refresh.id))).toBe(true);
		}, { timeout: 20000 });
		const next = await post(port, { text: 'next follower delivery' });
		await vi.waitFor(() => {
			expect(peer.requests.some(r => r.method === 'POST' && r.path === '/inbox/refreshed' && r.body.includes(next.id))).toBe(true);
		}, { timeout: 20000 });
		http.child.kill('SIGTERM'); worker.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0); expect((await worker.exit).code, worker.output()).toBe(0);
		expect(http.output()).not.toContain('note-post-save.failed'); expect(worker.output()).not.toContain('job.failed');
	} finally {
		await http.close(); await worker.close(); await config.close();
	}
});

test('disconnected accepted resolution drains on SIGTERM and persists through an ordinary process restart', async () => {
	const port = await freePort(); database.config.http.port = port; peer.route('local.test', port);
	const config = await configuration(database.config);
	const http = launch('built/entrypoints/http.js', config.path, { MISSKEY_WEBFINGER_USE_HTTP: 'true' });
	register('drainpeer'); gated = '/users/drainpeer'; entered = deferred(); release = deferred();
	const text = '@drainpeer@remote.test drain accepted';
	try {
		await http.ready;
		const req = request({ host: '127.0.0.1', port, path: '/api/notes/create', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
			res.resume();
		});
		req.on('error', () => { }); req.end(JSON.stringify({ i: token, text }));
		await entered.promise;
		req.destroy(); http.child.kill('SIGTERM');
		let exited = false; void http.exit.then(() => {
			exited = true;
		});
		await new Promise(resolve => setTimeout(resolve, 150)); expect(exited).toBe(false);
		release.resolve(); gated = null;
		expect((await http.exit).code, http.output()).toBe(0);
		const row = await source.getRepository(MiUser).findOneByOrFail({ usernameLower: 'drainpeer', host: 'remote.test' });
		const saved = await source.getRepository(MiNote).findOneByOrFail({ text }); expect(saved.mentions).toEqual([row.id]);
		const before = peer.requests.filter(r => r.method === 'GET').length;
		const restarted = launch('built/entrypoints/http.js', config.path, { MISSKEY_WEBFINGER_USE_HTTP: 'true' });
		try {
			await restarted.ready;
			const fresh = await post(port, { text: '@drainpeer@remote.test after restart', localOnly: true });
			expect((await source.getRepository(MiNote).findOneByOrFail({ id: fresh.id })).mentions).toEqual([row.id]);
			expect(peer.requests.filter(r => r.method === 'GET').length).toBe(before);
			restarted.child.kill('SIGTERM'); expect((await restarted.exit).code, restarted.output()).toBe(0);
		} finally {
			await restarted.close();
		}
	} finally {
		release.resolve(); gated = null; await http.close(); await config.close();
	}
});

test('ordinary shutdown deadline terminates a blocked accepted resolution without inventing retry promotion', async () => {
	const port = await freePort(); peer.route('local.test', port);
	const config = await configuration({ ...database.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 1000 } });
	const http = launch('built/entrypoints/http.js', config.path, { MISSKEY_WEBFINGER_USE_HTTP: 'true' });
	register('deadlinepeer'); gated = '/users/deadlinepeer'; entered = deferred(); release = deferred();
	try {
		await http.ready;
		const req = request({ host: '127.0.0.1', port, path: '/api/notes/create', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
			res.resume();
		});
		req.on('error', () => { }); req.end(JSON.stringify({ i: token, text: '@deadlinepeer@remote.test blocked by peer' }));
		await entered.promise; req.destroy();
		const started = Date.now(); http.child.kill('SIGTERM');
		expect((await http.exit).code).toBe(1); expect(http.output()).toContain('shutdown.timeout');
		expect(Date.now() - started).toBeGreaterThanOrEqual(800); expect(Date.now() - started).toBeLessThan(5000);
		expect(await source.getRepository(MiUser).countBy({ usernameLower: 'deadlinepeer', host: 'remote.test' })).toBe(0);
	} finally {
		release.resolve(); gated = null; await http.close(); await config.close();
	}
});

test('SIGTERM drains pending hashtag DB work after actor HTTP and posting have already settled', async () => {
	const { MiHashtag } = await import('backend-upstream/entities');
	const port = await freePort(); database.config.http.port = port; peer.route('local.test', port);
	const config = await configuration(database.config);
	const http = launch('built/entrypoints/http.js', config.path, { MISSKEY_WEBFINGER_USE_HTTP: 'true' });
	const lock = source.createQueryRunner();
	let transaction = false;
	register('hashtagdrain', { tag: [{ type: 'Hashtag', name: '#drainattached' }] });
	await source.getRepository(MiHashtag).insert({ id: codec.newId(Date.now()), name: 'drainattached' });
	try {
		await http.ready;
		await lock.connect(); await lock.startTransaction(); transaction = true;
		await lock.query('SELECT id FROM hashtag WHERE name = $1 FOR UPDATE', ['drainattached']);
		const note = await post(port, { text: '@hashtagdrain@remote.test', localOnly: true });
		const actor = await source.getRepository(MiUser).findOneByOrFail({ usernameLower: 'hashtagdrain', host: 'remote.test' });
		expect(peer.requests.some(req => req.path === '/users/hashtagdrain')).toBe(true);
		expect((await source.getRepository(MiNote).findOneByOrFail({ id: note.id })).mentions).toEqual([actor.id]);
		// Prove the held operation is the attached writer, not a still-pending actor request.
		await vi.waitFor(async () => {
			const blocked = await source.query('SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\' AND query LIKE \'%INSERT INTO "hashtag"%\'');
			expect(blocked.length).toBeGreaterThan(0);
		});
		http.child.kill('SIGTERM');
		let exited = false; void http.exit.then(() => {
			exited = true;
		});
		await new Promise(resolve => setTimeout(resolve, 200)); expect(exited).toBe(false);
		expect(await source.getRepository(MiHashtag).findOneBy({ name: 'drainattached' })).toMatchObject({ attachedUserIds: [], attachedUsersCount: 0 });
		await lock.commitTransaction(); transaction = false;
		expect((await http.exit).code, http.output()).toBe(0);
		expect(await source.getRepository(MiHashtag).findOneBy({ name: 'drainattached' })).toMatchObject({ attachedUserIds: [actor.id], attachedUsersCount: 1, attachedRemoteUserIds: [actor.id], attachedRemoteUsersCount: 1 });
		expect(http.output()).not.toContain('user-hashtags.failed');
	} finally {
		if (transaction) {
			await lock.rollbackTransaction();
		}
		await lock.release(); await http.close(); await config.close();
	}
});

// A unit-only renderer connection cannot satisfy the normal built HTTP child.
test('normal HTTP child publishes required local Profile facts', async () => {
	const port = await freePort(); database.config.http.port = port;
	await source.getRepository(MiUserProfile).update(authorId, { description: '**child**', followedMessage: '', location: 'Tokyo', fields: [{ name: 'site', value: 'https://example.com' }] });
	const config = await configuration(database.config);
	const http = launch('built/entrypoints/http.js', config.path);
	try {
		await http.ready;
		const response = await fetch(`http://127.0.0.1:${port}/users/${authorId}`, { headers: { Accept: 'application/activity+json' } });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ summary: '<b>child</b>', _misskey_summary: '**child**', _misskey_followedMessage: '', 'vcard:Address': 'Tokyo', attachment: [{ type: 'PropertyValue', name: 'site', value: '<a href="https://example.com/" rel="me nofollow noopener" target="_blank">https://example.com</a>' }] });
		http.child.kill('SIGTERM'); expect((await http.exit).code, http.output()).toBe(0);
	} finally {
		await http.close(); await config.close();
	}
});

// Both gates use real DB locks. HTTP response, pg_stat_activity and shutdown log events
// establish ordering; no elapsed sleep is used to infer that shutdown is waiting.
test.each(['register', 'increment'])('ordinary built HTTP responds with instance %s pending; SIGTERM drains before releasing connections', async stage => {
	const { MiInstance } = await import('backend-upstream/entities');
	await source.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	const port = await freePort(); database.config.http.port = port; peer.route('local.test', port);
	const config = await configuration(database.config);
	const name = `instancedrain_${stage}`;
	register(name, { publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'drain-key' } });
	// The previous child may have left a cache entry; this child must reach the intended gate.
	const { Redis } = await import('ioredis');
	const cache = new Redis(database.config.redis);
	await cache.del('kvcache:federatedInstance:remote.test'); await cache.quit();
	await source.getRepository(MiInstance).createQueryBuilder().insert().values({ id: codec.newId(Date.now()), host: 'remote.test', firstRetrievedAt: new Date() }).orIgnore().execute();
	const before = (await source.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).usersCount;
	const http = launch('built/entrypoints/http.js', config.path, { MISSKEY_WEBFINGER_USE_HTTP: 'true' });
	const lock = source.createQueryRunner(); let transaction = false;
	try {
		await http.ready; await lock.connect(); await lock.startTransaction(); transaction = true;
		if (stage === 'register') {
			await lock.query('LOCK TABLE instance IN ACCESS EXCLUSIVE MODE');
		} else {
			await lock.query('SELECT id FROM instance WHERE host = $1 FOR UPDATE', ['remote.test']);
		}
		const note = await post(port, { text: `@${name}@remote.test`, localOnly: true });
		const actor = await source.getRepository(MiUser).findOneByOrFail({ usernameLower: name, host: 'remote.test' });
		expect((await source.getRepository(MiNote).findOneByOrFail({ id: note.id })).mentions).toEqual([actor.id]);
		expect(await source.getRepository(MiUserProfile).countBy({ userId: actor.id })).toBe(1);
		await vi.waitFor(async () => {
			// pg_stat_activity truncates long SELECT projections before their FROM clause.
			// Identify our actual lock owner rather than matching that truncated suffix.
			const [{ pid }] = await lock.query('SELECT pg_backend_pid() AS pid');
			const rows: { query: string }[] = await source.query('SELECT query FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', [pid]);
			expect(rows.length, http.output()).toBeGreaterThan(0);
			expect(rows.some(row => stage === 'register' ? row.query.startsWith('SELECT') && row.query.includes('MiInstance') : row.query.startsWith('UPDATE') && row.query.includes('usersCount'))).toBe(true);
		});
		http.child.kill('SIGTERM');
		await vi.waitFor(async () => {
			await expect(new Promise<void>((resolve, reject) => {
				const socket = connect(port, '127.0.0.1');
				socket.once('connect', () => {
					socket.destroy(); resolve();
				}); socket.once('error', reject);
			})).rejects.toMatchObject({ code: 'ECONNREFUSED' });
		});
		expect(http.child.exitCode).toBeNull();
		// The lock is still held after the HTTP listener closes, so a successful exit cannot precede drain.
		await lock.commitTransaction(); transaction = false;
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await source.getRepository(MiInstance).findOneByOrFail({ host: 'remote.test' })).usersCount).toBe(before + 1);
		expect(http.output()).not.toContain('actor-instance-registration.failed');
	} finally {
		if (transaction) {
			await lock.rollbackTransaction();
		}
		await lock.release(); await http.close(); await config.close();
	}
});

test.each([false, true])('built public emoji extraction owns locked work through SIGTERM after early rejection=%s', async earlyFailure => {
	const { MiEmoji } = await import('backend-upstream/entities');
	const port = await freePort(); database.config.http.port = port; peer.route('local.test', port);
	const name = earlyFailure ? 'emojiearlydrain' : 'emojiawaitdrain';
	const emojiName = earlyFailure ? 'drain_early' : 'drain_await';
	await source.getRepository(MiEmoji).insert({ id: codec.newId(Date.now()), host: 'remote.test', name: emojiName, originalUrl: 'https://remote.test/old.png', publicUrl: 'https://remote.test/old.png', updatedAt: null });
	const tags = [{ type: 'Emoji', name: `:${emojiName}:`, icon: { url: 'https://remote.test/drained.png' } }];
	if (earlyFailure) {
		tags.push({ type: 'Emoji', name: ':drain_bad:', icon: { url: 'https://remote.test/' + 'x'.repeat(600) } });
	}
	register(name, { tag: tags });
	const config = await configuration(database.config);
	const preload = resolve('test/fixtures/emoji-refetch.mjs');
	const http = launch('built/entrypoints/http.js', config.path, {
		MISSKEY_WEBFINGER_USE_HTTP: 'true',
		...(earlyFailure ? {
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
			BACKEND_NEXT_TEST_EMOJI_REFETCH: emojiName,
		} : {}),
	});
	const lock = source.createQueryRunner(); let transaction = false;
	try {
		await http.ready; await lock.connect(); await lock.startTransaction(); transaction = true;
		await lock.query('SELECT id FROM emoji WHERE name = $1 AND host = $2 FOR UPDATE', [emojiName, 'remote.test']);
		const [{ pid }] = await lock.query('SELECT pg_backend_pid() AS pid');
		let responded = false;
		const response = post(port, { text: `@${name}@remote.test`, localOnly: true }).then(note => {
			responded = true; return note;
		});
		await vi.waitFor(async () => {
			const blocked: { query: string }[] = await source.query('SELECT query FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', [pid]);
			expect(blocked.some(row => row.query.startsWith('UPDATE "emoji"')), http.output()).toBe(true);
		});
		let note: { id: string } | undefined;
		if (earlyFailure) {
			note = await response;
			const actor = await source.getRepository(MiUser).findOneByOrFail({ usernameLower: name, host: 'remote.test' });
			expect(actor.emojis).toEqual([]);
			expect((await source.getRepository(MiNote).findOneByOrFail({ id: note.id })).mentions).toEqual([actor.id]);
		} else {
			expect(responded).toBe(false);
		}
		http.child.kill('SIGTERM');
		await vi.waitFor(async () => {
			await expect(new Promise<void>((resolve, reject) => {
				const socket = connect(port, '127.0.0.1');
				socket.once('connect', () => {
					socket.destroy(); resolve();
				}); socket.once('error', reject);
			})).rejects.toMatchObject({ code: 'ECONNREFUSED' });
		});
		expect(http.child.exitCode).toBeNull();
		await lock.commitTransaction(); transaction = false;
		if (earlyFailure) {
			await vi.waitFor(() => {
				expect(http.messages, http.output()).toContainEqual({ type: 'emoji-refetch-result', publicUrl: 'https://remote.test/drained.png' });
			}, { timeout: 3000 });
			expect(http.child.exitCode).toBeNull();
			http.child.send({ type: 'release-emoji-refetch' });
		}
		note ??= await response;
		expect((await http.exit).code, http.output()).toBe(0);
		expect(await source.getRepository(MiEmoji).findOneBy({ host: 'remote.test', name: emojiName })).toMatchObject({ originalUrl: 'https://remote.test/drained.png', publicUrl: 'https://remote.test/drained.png' });
		const actor = await source.getRepository(MiUser).findOneByOrFail({ usernameLower: name, host: 'remote.test' });
		expect(actor.emojis).toEqual(earlyFailure ? [] : [emojiName]);
		expect((await source.getRepository(MiNote).findOneByOrFail({ id: note.id })).mentions).toEqual([actor.id]);
	} finally {
		if (transaction) {
			await lock.rollbackTransaction();
		}
		await lock.release(); await http.close(); await config.close();
	}
});
