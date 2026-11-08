/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiChannel, MiFollowing, MiRelay, MiMeta, MiNote, MiUser, MiUserKeypair, MiUserProfile, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { verifyLdSignature } from '../helpers/ld-signature.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { startInboxRecorder } from '../helpers/outbound-http-fakes.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../src/config/types.js';
import type { InboxRecorder } from '../helpers/outbound-http-fakes.js';

const observations = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8')) as Record<string, unknown>;

// 本家の観測で fake inbox が待ち受けたアドレス。観測の本文はこの値のまま記録されている。
const observedInbox = 'http://127.0.0.1:63167';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let inbox: InboxRecorder;
let publicKeyPem: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
	inbox = await startInboxRecorder();
	const { codec } = seeded;

	const alice = seeded.actors.ordinary.id;
	const bob = seeded.actors.moderator.id;
	ids.alice = alice;
	const pair = await generateRsaKeyPair();
	publicKeyPem = pair.publicKeyPem;
	await source.getRepository(MiUserKeypair).insert({ userId: alice, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await source.getRepository(MiUserProfile).insert([{ userId: alice, userHost: null }, { userId: bob, userHost: null }]);
	await source.getRepository(MiRelay).insert(['accepted', 'requesting', 'rejected'].map(status => ({ id: status, inbox: `${inbox.origin}/inbox/${status === 'accepted' ? 'relay' : status}`, status: status as 'accepted' | 'requesting' | 'rejected' })));
	await source.getRepository(MiMeta).update({ id: 'singleton' }, { federation: 'all' });

	// 本家の観測と同じく、remote1・remote2 は同じ shared inbox を持ち、alice をフォローする。
	const host = new URL(inbox.origin).host;
	for (const name of ['remote1', 'remote2']) {
		const id = codec.newId(Date.now());
		ids[name] = id;
		await source.getRepository(MiUser).insert({
			id, username: name, usernameLower: name, host, uri: `${inbox.origin}/users/${name}`, inbox: `${inbox.origin}/inbox/${name}`, sharedInbox: `${inbox.origin}/inbox/shared`,
		});
		await source.getRepository(MiFollowing).insert({
			id: codec.newId(Date.now()), followerId: id, followeeId: alice, followerHost: host, followerInbox: `${inbox.origin}/inbox/${name}`, followerSharedInbox: `${inbox.origin}/inbox/shared`,
		});
	}
	ids['remote-base'] = codec.newId(Date.now());
	await source.getRepository(MiNote).insert({ id: ids['remote-base'], userId: ids.remote1, userHost: host, text: 'remote', visibility: 'public', uri: `${inbox.origin}/notes/remote-base` });
	ids.base = codec.newId(Date.now());
	await source.getRepository(MiNote).insert({ id: ids.base, userId: bob, userHost: null, text: 'base', visibility: 'public' });
	ids.channel = codec.newId(Date.now());
	await source.getRepository(MiChannel).insert({ id: ids.channel, name: 'channel', userId: alice, isArchived: false, allowRenoteToExternal: false });
});

afterAll(async () => {
	await inbox?.close();
	await source?.destroy();
	await database?.close();
});

function processConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	const prefix = `note-deliver-process-${randomUUID()}`;
	return { ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` }, ...overrides };
}

async function create(port: number, name: string, input: Record<string, unknown>): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, ...input }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	ids[name] = (await response.json() as { createdNote: { id: string } }).createdNote.id;
	return ids[name];
}

/** 実行ごとに変わる ID・origin・ポート・時刻を、本家の観測と同じ名前へ戻す。 */
function normalize(body: string, origin: string): unknown {
	let text = body.replaceAll(new URL(inbox.origin).host, new URL(observedInbox).host).replaceAll(origin, '$origin');
	for (const [name, id] of Object.entries(ids)) {
		text = text.replaceAll(id, `$${name}`);
	}
	return JSON.parse(text, (key, value: unknown) => (['published', 'created'].includes(key) ? '$time' : key === 'nonce' ? '$nonce' : key === 'signatureValue' ? '$signature' : value));
}

test('notes created over HTTP are delivered by the worker process to the fake inboxes like the pinned upstream (including accepted relay)', async () => {
	const port = await freePort();
	const value = processConfig({ http: { port } });
	const config = await configuration(value);
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	try {
		await Promise.all([http.ready, worker.ready]);

		for (const visibility of ['public', 'home', 'followers', 'specified']) {
			await create(port, `ap-${visibility}`, { text: 'AP contract', visibility, visibleUserIds: [ids.remote1], ...(visibility === 'public' ? { replyId: ids['remote-base'] } : {}) });
		}
		const local = await create(port, 'ap-local', { text: 'local', localOnly: true });
		const channel = await create(port, 'ap-channel', { text: 'channel', channelId: ids.channel });
		await create(port, 'ap-pure', { renoteId: ids.base });
		await create(port, 'ap-quote', { text: 'quote', renoteId: ids.base });

		// C9 の全宛先。
		const expected: Record<string, string[]> = {
			'ap-public': ['/inbox/relay', '/inbox/shared'], 'ap-home': ['/inbox/shared'], 'ap-followers': ['/inbox/shared'], 'ap-specified': ['/inbox/remote1'],
			'ap-pure': ['/inbox/relay', '/inbox/shared'], 'ap-quote': ['/inbox/relay', '/inbox/shared'],
		};
		const total = Object.values(expected).flat().length;
		expect(total).toBe(9);
		await vi.waitFor(() => {
			expect(inbox.deliveries).toHaveLength(total);
		}, { timeout: 20000, interval: 100 });
		// localOnly・channel の投稿の配送が遅れて届かないことを、有限の時間だけ確かめる。
		await new Promise(resolve => setTimeout(resolve, 500));
		expect(inbox.deliveries).toHaveLength(total);
		expect(inbox.deliveries.some(d => d.body.includes(local) || d.body.includes(channel))).toBe(false);

		for (const [name, paths] of Object.entries(expected)) {
			const key = `C9-${name.slice(3)}`;
			const received = inbox.deliveries.filter(d => d.body.includes(`/notes/${ids[name]}/activity`)).sort((a, b) => a.path.localeCompare(b.path));
			expect(received.map(d => d.path)).toEqual(paths);
			const upstream = (observations[key] as { path: string; activity: unknown; signed: boolean; digest: boolean }[]);
			for (const d of received) {
				expect(d.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
				const raw = JSON.parse(d.body);
				if (d.path === '/inbox/relay') {
					expect(await verifyLdSignature(raw, publicKeyPem)).toBe(true);
					expect(raw.signature).toEqual({ type: 'RsaSignature2017', creator: `${value.url}/users/${ids.alice}#main-key`, nonce: expect.stringMatching(/^[0-9a-f]{32}$/), created: expect.any(String), signatureValue: expect.any(String) });
					expect(new Date(raw.signature.created).toISOString()).toBe(raw.signature.created);
				} else {
					expect(raw.signature).toBeUndefined();
				}
			}
			expect(received.map(d => ({ path: d.path, activity: normalize(d.body, value.url) }))).toEqual(upstream.map(o => ({ path: o.path, activity: o.activity })));
			for (const delivery of received) {
				expect(delivery.keyId).toBe(`${value.url}/users/${ids.alice}#main-key`);
				expect(delivery.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
			}
		}
		expect(observations['C9-localOnly']).toEqual({ deliveries: [] });

		http.child.kill('SIGTERM');
		worker.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await worker.exit).code, worker.output()).toBe(0);
		expect(http.output()).not.toContain('note-post-save.failed');
		expect(worker.output()).not.toContain('job.failed');
		expect(worker.output()).not.toContain('deliver.instance-update-failed');
	} finally {
		await http.close();
		await worker.close();
		await config.close();
	}
});

// Composed evidence: C4 corrected-operation HTTP/storage observations plus pinned
// ApRendererService home-plain source-method audiences, not an upstream server run.
test.each(['sensitive', 'policy'])('C4-%s correction reaches source-backed home AP audiences', async correction => {
	const port = await freePort();
	const value = processConfig({ http: { port } });
	const config = await configuration(value);
	const roleId = seeded.codec.newId(Date.now());
	if (correction === 'sensitive') {
		await source.getRepository(MiMeta).update('singleton', { sensitiveWords: ['needle'] });
	} else {
		await source.getRepository(MiRole).insert({ id: roleId, name: 'no public', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
		await source.query('UPDATE role SET policies=$1 WHERE id=$2', [{ canPublicNote: { useDefault: false, priority: 1, value: false } }, roleId]);
		await source.getRepository(MiRoleAssignment).insert({ id: seeded.codec.newId(Date.now()), roleId, userId: ids.alice });
	}
	const inspect = new Queue('deliver', baseQueueOptions(value.redisForJobQueue, 'deliver', 5000));
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	try {
		await Promise.all([http.ready, worker.ready]);
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ i: seeded.actors.ordinary.token, text: correction === 'sensitive' ? 'needle' : 'hello', visibility: 'public' }),
		});
		expect(response.status).toBe(200);
		const { createdNote } = await response.json() as { createdNote: { id: string; visibility: string } };
		expect(createdNote.visibility).toBe((observations[`C4-${correction}`] as { saved: { visibility: string } }).saved.visibility);
		expect((await source.getRepository(MiNote).findOneByOrFail({ id: createdNote.id })).visibility).toBe('home');
		const show = await fetch(`http://127.0.0.1:${port}/api/notes/show`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, noteId: createdNote.id }),
		});
		expect(show.status).toBe(200);
		expect(await show.json()).toMatchObject({ id: createdNote.id, visibility: 'home' });
		// Drain accepted producers first; then queue completion bounds absence of relay delivery.
		http.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		await vi.waitFor(async () => expect(await inspect.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')).toEqual({ waiting: 0, active: 0, delayed: 0, completed: 1, failed: 0 }), { timeout: 10000 });
		const received = inbox.deliveries.filter(d => d.body.includes(`/notes/${createdNote.id}/activity`));
		expect(received.map(d => d.path)).toEqual(['/inbox/shared']);
		const render = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/ap-deliver/render-cases.json', import.meta.url), 'utf8'));
		const fixed = JSON.parse(render.cases.find((entry: { id: string }) => entry.id === 'home-plain').activity);
		const audience = (activity: { to: string[]; cc: string[] }) => ({ to: activity.to, cc: activity.cc });
		const expected = JSON.parse(JSON.stringify(audience(fixed)).replaceAll(`${render.inputs.selfUrl}/users/alice`, `${value.url}/users/${ids.alice}`));
		const actual = JSON.parse(received[0].body);
		expect(audience(actual)).toEqual(expected);
		expect(audience(actual.object)).toEqual(expected);
		expect(received[0].verify(publicKeyPem)).toEqual({ signature: true, digest: true });
		worker.child.kill('SIGTERM');
		expect((await worker.exit).code, worker.output()).toBe(0);
		expect(http.output()).not.toContain('note-post-save.failed');
		expect(worker.output()).not.toContain('job.failed');
	} finally {
		await http.close(); await worker.close();
		await inspect.obliterate({ force: true }); await inspect.close(); await config.close();
		await source.getRepository(MiMeta).update('singleton', { sensitiveWords: [] });
		if (correction === 'policy') {
			await source.getRepository(MiRoleAssignment).delete({ roleId });
			await source.getRepository(MiRole).delete(roleId);
		}
	}
});

test('losing the deliver queue connection of a worker stops the whole process tree abnormally', async () => {
	const value = processConfig({ http: { port: await freePort() } });
	const config = await configuration(value);
	const control = new Redis(database.config.redis);
	const supervisor = launch('built/entrypoints/supervisor.js', config.path);
	let children: { role: string; pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((message: any) => message.role === 'supervisor') as { children: typeof children }).children;
		let blocking: string | undefined;
		await vi.waitFor(async () => {
			blocking = String(await control.client('LIST')).split('\n')
				.find(line => line.includes(`name=${value.redisForJobQueue.prefix}:queue:deliver:`) && line.includes('cmd=bzpopmin'));
			expect(blocking).toBeDefined();
		}, { timeout: 5000, interval: 50 });
		await control.client('KILL', 'ID', blocking!.match(/^id=(\d+)/)![1]);

		expect((await supervisor.exit).code, supervisor.output()).toBe(1);
		expect(supervisor.output()).toContain('JOB_QUEUE_REDIS_ENDED');
		expect(supervisor.output()).toContain('"queue":"deliver"');
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		control.disconnect();
		await supervisor.close();
		for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
		await config.close();
	}
});

test('HTTP success precedes relay preparation; SIGTERM drains the blocked relay query and enqueues before exit', async () => {
	const port = await freePort();
	const value = processConfig({ http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 15000 } });
	const config = await configuration(value);
	const lock = source.createQueryRunner();
	const inspect = new Queue('deliver', baseQueueOptions(value.redisForJobQueue, 'deliver', 5000));
	const http = launch('built/entrypoints/http.js', config.path);
	let worker: ReturnType<typeof launch> | undefined;
	let locked = false;
	try {
		await http.ready;
		await lock.connect();
		await lock.startTransaction();
		locked = true;
		await lock.query('LOCK TABLE relay IN ACCESS EXCLUSIVE MODE');
		const noteId = await create(port, 'draining-relay', { text: 'drain relay', visibility: 'public' });
		expect(await source.getRepository(MiNote).findOneBy({ id: noteId })).not.toBeNull();
		await vi.waitFor(async () => {
			const blocked = await source.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'SELECT%relay%'");
			expect(blocked.length).toBeGreaterThan(0);
		}, { timeout: 5000 });
		let exited = false;
		void http.exit.then(() => {
			exited = true;
		});
		http.child.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(exited).toBe(false);
		await lock.commitTransaction();
		locked = false;
		expect((await http.exit).code, http.output()).toBe(0);
		const waiting = await inspect.getJobs(['waiting']);
		const relay = waiting.filter(j => j.data.to === `${inbox.origin}/inbox/relay`);
		expect(relay).toHaveLength(1);
		expect(await verifyLdSignature(JSON.parse(relay[0].data.content), publicKeyPem)).toBe(true);
		worker = launch('built/entrypoints/worker.js', config.path);
		await worker.ready;
		await vi.waitFor(() => expect(inbox.deliveries.some(d => d.path === '/inbox/relay' && d.body.includes(noteId))).toBe(true), { timeout: 10000 });
		const delivered = inbox.deliveries.find(d => d.path === '/inbox/relay' && d.body.includes(noteId))!;
		expect(delivered.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
		expect(await verifyLdSignature(JSON.parse(delivered.body), publicKeyPem)).toBe(true);
	} finally {
		if (locked) {
			await lock.rollbackTransaction();
		}
		await lock.release();
		await http.close();
		await worker?.close();
		await inspect.obliterate({ force: true });
		await inspect.close();
		await config.close();
	}
});
