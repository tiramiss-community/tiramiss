/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiChannel, MiFollowing, MiRelay, MiMeta, MiNote, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
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
	const prefix = `note-delete-process-${randomUUID()}`;
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

async function remove(port: number, noteId: string, actor = 'ordinary') {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors[actor].token, noteId }) });
	expect(response.status, await response.clone().text()).toBe(204);
}

function forDeleted(noteId: string, type: string) {
	return inbox.deliveries.filter(receipt => {
		const activity = JSON.parse(receipt.body);
		return activity.type === type && receipt.body.includes(`/notes/${noteId}`);
	}).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizedDeletion(body: string, origin: string, name: string, type: string) {
	const activity = JSON.parse(body);
	// Assert random UUID before replacing it; all receipt IDs are compared before normalization below.
	expect(activity.id).toMatch(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
	activity.id = `${origin}/$activity-${type}-$${name}`;
	return normalize(JSON.stringify(activity), origin);
}

test('C10 Delete, Undo, missing-original fallback and F8 nonpublic late followers match fixed upstream with raw signature verification', async () => {
	const port = await freePort();
	const value = processConfig({ url: 'http://127.0.0.1:61167', http: { port } });
	const config = await configuration(value);
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	try {
		await Promise.all([http.ready, worker.ready]);
		await create(port, 'ap-public', { text: 'AP contract', replyId: ids['remote-base'], visibleUserIds: [ids.remote1] });
		await create(port, 'ap-pure', { renoteId: ids.base });
		const fallbackBase = seeded.codec.newId(Date.now());
		await source.getRepository(MiNote).insert({ id: fallbackBase, userId: seeded.actors.moderator.id, text: 'fallback', visibility: 'public' });
		const fallback = await create(port, 'fallback-renote', { renoteId: fallbackBase });
		await vi.waitFor(() => expect(inbox.deliveries.filter(d => d.body.includes(`/notes/${fallback}/activity`) && JSON.parse(d.body).type === 'Announce')).toHaveLength(2), { timeout: 20000 });
		await source.getRepository(MiNote).delete({ id: fallbackBase });
		for (const [name, type, key, paths] of [
			['ap-public', 'Delete', 'C10-Delete', ['/inbox/relay', '/inbox/remote1', '/inbox/shared']],
			['ap-pure', 'Undo', 'C10-Undo', ['/inbox/relay', '/inbox/shared']],
			['fallback-renote', 'Delete', 'C10-fallback', ['/inbox/relay', '/inbox/shared']],
		] as const) {
			await remove(port, ids[name], name === 'ap-public' ? 'moderator' : 'ordinary');
			await vi.waitFor(() => expect(forDeleted(ids[name], type).map(d => d.path)).toEqual(paths), { timeout: 20000 });
			const received = forDeleted(ids[name], type);
			expect(new Set(received.map(d => JSON.parse(d.body).id)).size).toBe(1);
			for (const receipt of received) {
				expect(receipt.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
				expect(receipt.keyId).toBe(`${value.url}/users/${ids.alice}#main-key`);
				const raw = JSON.parse(receipt.body);
				if (receipt.path === '/inbox/relay') {
					expect(await verifyLdSignature(raw, publicKeyPem)).toBe(true);
					expect(raw.signature.creator).toBe(`${value.url}/users/${ids.alice}#main-key`);
				} else {
					expect(raw.signature).toBeUndefined();
					expect(raw.to).toBeUndefined();
				}
			}
			expect(received.map(d => ({ path: d.path, activity: normalizedDeletion(d.body, value.url, name, type) }))).toEqual((observations[key] as { path: string; activity: unknown }[]).map(d => ({ path: d.path, activity: d.activity })));
			expect(await source.getRepository(MiNote).existsBy({ id: ids[name] })).toBe(false);
		}
		for (const visibility of ['home', 'followers', 'specified']) {
			await create(port, `ap-${visibility}`, { text: 'AP contract', visibility, visibleUserIds: [ids.remote1] });
		}
		ids.late = seeded.codec.newId(Date.now());
		const host = new URL(inbox.origin).host;
		await source.getRepository(MiUser).insert({ id: ids.late, username: 'late', usernameLower: 'late', host, uri: `${inbox.origin}/users/late`, inbox: `${inbox.origin}/inbox/late` });
		await source.getRepository(MiFollowing).insert({ id: seeded.codec.newId(Date.now()), followerId: ids.late, followeeId: ids.alice, followerHost: host, followerInbox: `${inbox.origin}/inbox/late` });
		for (const visibility of ['home', 'followers', 'specified']) {
			const name = `ap-${visibility}`;
			await remove(port, ids[name]);
			const expected = observations[`F8-upstream-${visibility}`] as { path: string; activity: unknown }[];
			await vi.waitFor(() => expect(forDeleted(ids[name], 'Delete').map(d => d.path)).toEqual(expected.map(d => d.path)), { timeout: 20000 });
			const received = forDeleted(ids[name], 'Delete');
			for (const receipt of received) {
				expect(receipt.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
				if (receipt.path === '/inbox/relay') {
					expect(await verifyLdSignature(JSON.parse(receipt.body), publicKeyPem)).toBe(true);
				}
			}
			expect(received.map(d => ({ path: d.path, activity: normalizedDeletion(d.body, value.url, name, 'Delete') }))).toEqual(expected.map(d => ({ path: d.path, activity: d.activity })));
		}
		http.child.kill('SIGTERM'); worker.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await worker.exit).code, worker.output()).toBe(0);
		expect(http.output()).not.toContain('note-post-delete.failed');
		expect(worker.output()).not.toContain('job.failed');
	} finally {
		await http.close(); await worker.close(); await config.close();
	}
});

test('DELETE returns 204 while relay query is blocked; SIGTERM drains deletion work before closing queue', async () => {
	const port = await freePort();
	const value = processConfig({ http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 15000 } });
	const config = await configuration(value);
	const lock = source.createQueryRunner();
	const inspect = new Queue('deliver', baseQueueOptions(value.redisForJobQueue, 'deliver', 5000));
	const http = launch('built/entrypoints/http.js', config.path);
	let locked = false;
	try {
		await http.ready;
		const target = seeded.codec.newId(Date.now());
		await source.getRepository(MiNote).insert({ id: target, userId: ids.alice, visibility: 'specified', text: 'drain delete' });
		await lock.connect(); await lock.startTransaction(); locked = true;
		await lock.query('LOCK TABLE relay IN ACCESS EXCLUSIVE MODE');
		await remove(port, target, 'moderator');
		expect(await source.getRepository(MiNote).existsBy({ id: target })).toBe(false);
		await vi.waitFor(async () => {
			const blocked = await source.query('SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\' AND query ILIKE \'SELECT%relay%\'');
			expect(blocked.length).toBeGreaterThan(0);
		});
		let exited = false; void http.exit.then(() => {
			exited = true;
		});
		http.child.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(exited).toBe(false);
		await lock.commitTransaction(); locked = false;
		expect((await http.exit).code, http.output()).toBe(0);
		const jobs = await inspect.getJobs(['waiting']);
		const relay = jobs.filter(job => job.data.to === `${inbox.origin}/inbox/relay`);
		expect(relay).toHaveLength(1);
		expect(JSON.parse(relay[0].data.content).object.id).toBe(`${value.url}/notes/${target}`);
		expect(await verifyLdSignature(JSON.parse(relay[0].data.content), publicKeyPem)).toBe(true);
	} finally {
		if (locked) {
			await lock.rollbackTransaction();
		}
		await lock.release(); await http.close();
		await inspect.obliterate({ force: true }); await inspect.close(); await config.close();
	}
});
