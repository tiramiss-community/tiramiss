/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Meilisearch } from 'meilisearch';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiFollowing, MiHashtag, MiMeta, MiModerationLog, MiNote, MiPoll, MiUser, MiUserKeypair, MiUserProfile, MiWebhook } from 'backend-upstream/entities';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { startInboxRecorder } from '../helpers/outbound-http-fakes.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { gate, searchGateway } from '../helpers/search-gateway.js';
import type { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../src/config/types.js';

interface SourceObservation {
	id: string;
	calls: { method: string; args?: { type?: string } }[];
	state: {
		noteExists: boolean; searchDocumentExists: boolean;
		ordinaryTimeline: string[]; hashtags: string[]; notifications: string[]; webhooks: unknown[];
	};
}
const sourceObservations = (JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/delete-integration/observations.json', import.meta.url), 'utf8')) as { observations: SourceObservation[] }).observations;

interface HookReceipt { type: string; body: { note: { id: string; text: string } } }
interface StreamMessage { type: string; body: { id?: string; type?: string; body?: { id?: string; note?: { id: string }; deletedAt?: string } } }
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let inbox: Awaited<ReturnType<typeof startInboxRecorder>>;
let hookServer: ReturnType<typeof createServer>;
let publicKeyPem: string;
const hooks: HookReceipt[] = [];
const client = new Meilisearch({ host: `http://127.0.0.1:${process.env.BACKEND_NEXT_TEST_MEILI_PORT ?? 57779}` });

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
	await source.getRepository(MiMeta).update({ id: 'singleton' }, { federation: 'all' });
	inbox = await startInboxRecorder();
	const author = seeded.actors.ordinary.id;
	const viewer = seeded.actors.root.id;
	await source.getRepository(MiUserProfile).insert([{ userId: author }, { userId: viewer }]);
	await source.getRepository(MiFollowing).insert({ id: seeded.codec.newId(Date.now()), followerId: viewer, followeeId: author });
	const pair = await generateRsaKeyPair();
	publicKeyPem = pair.publicKeyPem;
	await source.getRepository(MiUserKeypair).insert({ userId: author, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	const remote = seeded.codec.newId(Date.now());
	const host = new URL(inbox.origin).host;
	await source.getRepository(MiUser).insert({ id: remote, username: 'remote', usernameLower: 'remote', host, uri: `${inbox.origin}/users/remote`, inbox: `${inbox.origin}/inbox/remote` });
	await source.getRepository(MiFollowing).insert({ id: seeded.codec.newId(Date.now()), followerId: remote, followeeId: author, followerHost: host, followerInbox: `${inbox.origin}/inbox/remote` });
	hookServer = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(chunk as Buffer);
		}
		hooks.push(JSON.parse(Buffer.concat(chunks).toString()) as HookReceipt);
		response.writeHead(204).end();
	});
	await new Promise<void>(resolve => hookServer.listen(0, '127.0.0.1', resolve));
	const hookUrl = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/hook`;
	await source.getRepository(MiWebhook).insert([
		{ id: 'author-hook', userId: author, name: 'author', active: true, on: ['note'], url: hookUrl, secret: 'test-only' },
		{ id: 'viewer-hook', userId: viewer, name: 'viewer', active: true, on: ['mention'], url: hookUrl, secret: 'test-only' },
	]);
});

afterAll(async () => {
	await inbox?.close();
	if (hookServer) {
		await new Promise<void>((resolve, reject) => hookServer.close(error => error ? reject(error) : resolve()));
	}
	await source?.destroy();
	await database?.close();
});

function processConfig(port: number): RuntimeConfig {
	const prefix = `delete-integration-${randomUUID()}`;
	return {
		...database.config, http: { port },
		redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` },
		redisForTimelines: { ...database.config.redis, db: 6, prefix, keyPrefix: `${prefix}:` },
		fulltextSearch: { provider: 'meilisearch' },
		meilisearch: { host: '127.0.0.1', port: process.env.BACKEND_NEXT_TEST_MEILI_PORT ?? '57779', apiKey: '', index: prefix },
		processes: { ...database.config.processes, shutdownTimeoutMs: 10000 },
	};
}

async function api(port: number, endpoint: string, input: object, actor = 'ordinary') {
	return fetch(`http://127.0.0.1:${port}/api/notes/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors[actor].token, ...input }) });
}

async function websocket(port: number) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/streaming?i=${seeded.actors.root.token}`);
	const messages: StreamMessage[] = [];
	socket.on('message', data => messages.push(JSON.parse(data.toString()) as StreamMessage));
	await new Promise<void>((resolve, reject) => {
		socket.once('open', resolve);
		socket.once('error', reject);
	});

	async function channel(name: string, id = name) {
		socket.send(JSON.stringify({ type: 'connect', body: { id, channel: name, pong: true } }));
		await vi.waitFor(() => expect(messages).toContainEqual({ type: 'connected', body: { id } }));
	}

	await channel('main');
	await channel('homeTimeline');
	return {
		socket, messages,
		async subscribe(noteId: string) {
			socket.send(JSON.stringify({ type: 'sr', body: { id: noteId } }));
			await channel('homeTimeline', 'subscription-barrier');
		},
	};
}

async function stop(child: ReturnType<typeof launch>) {
	child.child.kill('SIGTERM');
	expect((await child.exit).code, child.output()).toBe(0);
}

async function queueIdle(queues: Queue[]) {
	await vi.waitFor(async () => {
		for (const queue of queues) {
			expect(await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 0 });
		}
	}, { timeout: 10000, interval: 20 });
}

function deliveries(noteId: string) {
	return inbox.deliveries.filter(receipt => receipt.body.includes(`/notes/${noteId}`));
}

function receipts(noteId: string) {
	return hooks.filter(receipt => receipt.body.note.id === noteId);
}

async function history(noteId: string, tag: string, redis: Redis, timelines: Redis) {
	const keys = (await redis.keys(`${database.config.redis.keyPrefix}*`))
		.map(key => key.slice(database.config.redis.keyPrefix!.length))
		.filter(key => key.startsWith(`hashtagUsers:${tag}`) || key.startsWith('featuredHashtagsRanking:')).sort();
	return {
		notifications: await source.query('SELECT * FROM backend_internal.notification WHERE note_id = $1 ORDER BY notification_id', [noteId]),
		hashtag: await source.getRepository(MiHashtag).findOneByOrFail({ name: tag }),
		ranking: await Promise.all(keys.map(async key => ({ key, value: await redis.dump(key) }))),
		local: await timelines.lrange('list:localTimeline', 0, -1),
		author: await timelines.lrange(`list:userTimeline:${seeded.actors.ordinary.id}`, 0, -1),
		home: await timelines.lrange(`list:homeTimeline:${seeded.actors.root.id}`, 0, -1),
	};
}

// A change that delays stream/AP/search until physical DELETE, or purges historical
// creation effects, must fail this same production process graph.
test.each([false, true])('ordinary processes preserve deletion boundaries across PG/Redis/Meili/WS/AP/webhooks (DELETE rejected: %s)', async rejectDelete => {
	const port = await freePort();
	const value = processConfig(port);
	const config = await configuration(value);
	const index = client.index(`${value.meilisearch!.index}---notes`);
	const redis = new Redis(value.redis);
	const timelines = new Redis(value.redisForTimelines!);
	const queues = ['deliver', 'userWebhookDeliver'].map(name => new Queue(name, baseQueueOptions(value.redisForJobQueue, name, 5000)));
	const httpChildren: ReturnType<typeof launch>[] = [];
	const startHttp = () => {
		const child = launch('built/entrypoints/http.js', config.path);
		httpChildren.push(child);
		return child;
	};
	let http = startHttp();
	const worker = launch('built/entrypoints/worker.js', config.path);
	let viewer: Awaited<ReturnType<typeof websocket>> | undefined;
	let trigger = false;

	async function tasksApplied() {
		const tasks = await client.tasks.getTasks({ indexUids: [index.uid], limit: 1000 });
		for (const task of tasks.results) {
			expect((await client.tasks.waitForTask(task.uid, { timeout: 10000, interval: 20 })).status).toBe('succeeded');
		}
		return tasks.results.map(task => task.uid);
	}

	try {
		await Promise.all([http.ready, worker.ready]);
		viewer = await websocket(port);
		const tag = rejectDelete ? 'deletefailure' : 'deletesuccess';
		const text = `@root #${tag} integrated poll`;
		const created = await api(port, 'create', { text, poll: { choices: ['one', 'two'] } });
		expect(created.status, await created.clone().text()).toBe(200);
		const noteId = (await created.json() as { createdNote: { id: string } }).createdNote.id;
		await viewer.subscribe(noteId);
		const shown = await api(port, 'show', { noteId });
		expect(shown.status).toBe(200);
		expect(await shown.json()).toMatchObject({ id: noteId, text, poll: { choices: [{ text: 'one' }, { text: 'two' }] } });
		expect(await source.getRepository(MiNote).existsBy({ id: noteId })).toBe(true);
		expect(await source.getRepository(MiPoll).existsBy({ noteId })).toBe(true);
		await vi.waitFor(async () => {
			for (const type of ['note', 'mention', 'notification']) {
				expect(viewer!.messages.some(message => message.body.type === type && (message.body.body?.id === noteId || message.body.body?.note?.id === noteId))).toBe(true);
			}
			expect(receipts(noteId).map(receipt => receipt.type).sort()).toEqual(['mention', 'note']);
			expect(deliveries(noteId).map(receipt => JSON.parse(receipt.body).type)).toEqual(['Create']);
			expect(await timelines.lrange('list:localTimeline', 0, -1)).toContain(noteId);
			expect(await timelines.lrange(`list:homeTimeline:${seeded.actors.root.id}`, 0, -1)).toContain(noteId);
			expect(await redis.sismember(`hashtagUsers:${tag}`, seeded.actors.ordinary.id)).toBe(1);
			expect(await source.getRepository(MiHashtag).existsBy({ name: tag })).toBe(true);
			expect((await index.getDocument(noteId)).text).toBe(text);
		}, { timeout: 15000, interval: 30 });
		await queueIdle(queues);
		const before = await history(noteId, tag, redis, timelines);
		expect(before.notifications).toHaveLength(1);
		expect(before.author).toContain(noteId);
		expect(before.ranking.length).toBeGreaterThanOrEqual(3);
		const beforeTasks = await tasksApplied();
		const beforeJobs = await Promise.all(queues.map(queue => queue.getJobCounts('completed')));
		const beforeHooks = structuredClone(receipts(noteId));
		const denied = await api(port, 'delete', { noteId }, 'expired');
		expect(denied.status).toBe(400);
		expect(await denied.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
		// HTTP shutdown drains accepted producers; idle queues and applied tasks make
		// the rejected request's non-effects a completed-work assertion.
		await stop(http); await queueIdle(queues);
		expect(await history(noteId, tag, redis, timelines)).toEqual(before);
		expect(await tasksApplied()).toEqual(beforeTasks);
		expect(await Promise.all(queues.map(queue => queue.getJobCounts('completed')))).toEqual(beforeJobs);
		expect(deliveries(noteId)).toHaveLength(1);
		expect(receipts(noteId)).toEqual(beforeHooks);
		expect(viewer.messages.filter(message => message.type === 'noteUpdated')).toEqual([]);
		expect(await source.getRepository(MiNote).existsBy({ id: noteId })).toBe(true);
		expect(await source.getRepository(MiPoll).existsBy({ noteId })).toBe(true);
		viewer.socket.terminate();
		http = startHttp(); await http.ready;
		viewer = await websocket(port); await viewer.subscribe(noteId);
		const audits = await source.getRepository(MiModerationLog).count();
		if (rejectDelete) {
			await source.query(`CREATE FUNCTION integration_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${noteId}' THEN RAISE EXCEPTION 'injected DELETE rejection'; END IF; RETURN OLD; END $$`);
			await source.query('CREATE TRIGGER integration_fail_delete BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION integration_fail_delete()');
			trigger = true;
		}
		const deleted = await api(port, 'delete', { noteId }, 'moderator');
		expect(deleted.status, await deleted.clone().text()).toBe(rejectDelete ? 500 : 204);
		await vi.waitFor(() => expect(viewer!.messages.find(message => message.type === 'noteUpdated')).toEqual({ type: 'noteUpdated', body: { id: noteId, type: 'deleted', body: { deletedAt: expect.any(String) } } }));
		await stop(http); await queueIdle(queues); await tasksApplied();
		await stop(worker);
		expect(await source.getRepository(MiNote).existsBy({ id: noteId })).toBe(rejectDelete);
		expect(await source.getRepository(MiPoll).existsBy({ noteId })).toBe(rejectDelete);
		expect(await source.getRepository(MiModerationLog).count()).toBe(audits + (rejectDelete ? 0 : 1));
		expect(await history(noteId, tag, redis, timelines)).toEqual(before);
		expect(receipts(noteId)).toEqual(beforeHooks);
		expect(deliveries(noteId).map(receipt => JSON.parse(receipt.body).type)).toEqual(['Create', 'Delete']);
		for (const receipt of deliveries(noteId)) {
			expect(receipt.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
		}
		expect(JSON.parse(deliveries(noteId)[1].body)).toMatchObject({ actor: `${value.url}/users/${seeded.actors.ordinary.id}`, object: { id: `${value.url}/notes/${noteId}`, type: 'Tombstone' } });
		const searchDocument = await index.getDocument(noteId).catch((error: unknown) => {
			expect(error).toMatchObject({ cause: { code: 'document_not_found' } });
			return null;
		});
		expect(searchDocument).toBeNull();
		// Compare only observations this real graph shares with the fixed-source
		// method harness; the source probe does not execute databases or HTTP.
		const oracle = sourceObservations.find(observation => observation.id === (rejectDelete ? 'db-delete-reject' : 'success'))!;
		const retained = await history(noteId, tag, redis, timelines);
		expect({
			noteExists: await source.getRepository(MiNote).existsBy({ id: noteId }),
			searchDocumentExists: searchDocument !== null,
			ordinaryTimeline: retained.local.filter(id => id === noteId).map(() => 'retained'),
			hashtags: retained.hashtag.mentionedUserIds.includes(seeded.actors.ordinary.id) ? ['retained'] : [],
			notifications: retained.notifications.length === before.notifications.length ? ['retained'] : [],
			webhooks: receipts(noteId).slice(beforeHooks.length),
		}).toEqual(Object.fromEntries(['noteExists', 'searchDocumentExists', 'ordinaryTimeline', 'hashtags', 'notifications', 'webhooks'].map(key => [key, oracle.state[key as keyof SourceObservation['state']]])));
		expect(viewer.messages.find(message => message.type === 'noteUpdated')?.body.type).toBe(oracle.calls.find(call => call.method === 'deleted-stream')?.args?.type);
		expect(JSON.parse(deliveries(noteId)[1].body).type).toBe(oracle.calls.find(call => call.method === 'follower-delivery')?.args?.type);
		// Inspect show through a fresh normal HTTP child after all deletion work drained.
		http = startHttp(); await http.ready;
		const afterShow = await api(port, 'show', { noteId });
		expect(afterShow.status).toBe(rejectDelete ? 200 : 400);
		expect(await afterShow.json()).toMatchObject(rejectDelete ? { id: noteId, poll: { choices: [{ text: 'one' }, { text: 'two' }] } } : { error: { code: 'NO_SUCH_NOTE' } });
		await stop(http);
		for (const output of [...httpChildren, worker].map(child => child.output())) {
			expect(output).not.toMatch(/note-post-save.failed|note-post-delete.failed|job.failed|shutdown.timeout/);
		}
	} finally {
		if (trigger) {
			await source.query('DROP TRIGGER integration_fail_delete ON note');
			await source.query('DROP FUNCTION integration_fail_delete()');
		}
		viewer?.socket.terminate();
		await http.close(); await worker.close();
		for (const queue of queues) {
			await queue.obliterate({ force: true });
			await queue.close();
		}
		redis.disconnect(); timelines.disconnect(); await config.close();
		try {
			await client.tasks.waitForTask(await index.delete());
		} catch { /* Setup may fail before index creation. */ }
	}
});

test('failed held unindex submission preserves HTTP 204 and drains once with a search diagnostic', async () => {
	const entered = gate(); const held = gate();
	const gateway = await searchGateway(async request => {
		if (request.method === 'DELETE') {
			entered.release(); await held.promise;
			return { status: 503, body: { message: 'injected unindex failure', code: 'injected', type: 'internal', link: '' } };
		}
	});
	const port = await freePort();
	const config = await configuration({ ...processConfig(port), meilisearch: gateway.config });
	const http = launch('built/entrypoints/http.js', config.path);
	try {
		await http.ready;
		const created = await api(port, 'create', { text: 'unindex drain', localOnly: true });
		expect(created.status).toBe(200);
		const noteId = (await created.json() as { createdNote: { id: string } }).createdNote.id;
		await vi.waitFor(() => expect(gateway.requests.filter(request => request.method === 'POST')).toHaveLength(1));
		const deleted = await api(port, 'delete', { noteId });
		expect(deleted.status).toBe(204);
		await entered.promise;
		expect(await source.getRepository(MiNote).existsBy({ id: noteId })).toBe(false);
		let exited = false; void http.exit.then(() => {
			exited = true;
		});
		http.child.kill('SIGTERM');
		await vi.waitFor(async () => expect(await fetch(`http://127.0.0.1:${port}/health`, { headers: { Connection: 'close' } }).then(response => response.status === 503, () => true)).toBe(true));
		expect(exited).toBe(false);
		held.release();
		expect((await http.exit).code, http.output()).toBe(0);
		expect(gateway.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
		expect(gateway.requests.some(request => request.url.includes('/tasks'))).toBe(false);
		const failures = http.output().split('\n').filter(line => line.includes('note-post-delete.failed')).map(line => JSON.parse(line));
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ kind: 'search' });
		expect(await source.getRepository(MiNote).existsBy({ id: noteId })).toBe(false);
	} finally {
		held.release(); await http.close(); await config.close(); await gateway.close();
	}
});
