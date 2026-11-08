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

interface HookReceipt {
	type: string; body: { note: { id: string; text: string } };
	server: string; hookId: string; userId: string; eventId: string; createdAt: number;
	raw: string; receivedAt: number; secret: string | string[] | undefined;
}
interface StreamMessage { type: string; body: { id?: string; type?: string; body?: { id?: string; note?: { id: string }; deletedAt?: string; type?: string } } }
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let inbox: Awaited<ReturnType<typeof startInboxRecorder>>;
let hookServer: ReturnType<typeof createServer>;
let publicKeyPem: string;
const hooks: HookReceipt[] = [];
const hookStatuses = new Map<string, number>();
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
		const raw = Buffer.concat(chunks).toString();
		const payload = JSON.parse(raw) as HookReceipt;
		hooks.push({ ...payload, raw, receivedAt: Date.now(), secret: request.headers['x-misskey-hook-secret'] });
		response.writeHead(hookStatuses.get(payload.hookId) ?? 204).end();
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

async function websocket(port: number, actor = 'root') {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/streaming?i=${seeded.actors[actor].token}`);
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

// Shared with the existing deletion proof above: real recipients, PG, timelines,
// search and WS. These tests add ordinary queued-work continuation, not replay
// or exactly-once guarantees.
async function postingGraph() {
	const port = await freePort();
	const value = processConfig(port);
	const config = await configuration(value);
	const index = client.index(`${value.meilisearch!.index}---notes`);
	const redis = new Redis(value.redis);
	const timelines = new Redis(value.redisForTimelines!);
	const queues = ['deliver', 'userWebhookDeliver', 'endedPollNotification'].map(name => new Queue(name, baseQueueOptions(value.redisForJobQueue, name, 5000)));
	const graphs: ReturnType<typeof launch>[] = [];
	const streams: Awaited<ReturnType<typeof websocket>>[] = [];
	const children = (graph: ReturnType<typeof launch>) => (graph.messages.find((m: any) => m.role === 'supervisor') as { children: { role: string; pid: number }[] } | undefined)?.children ?? [];
	const gone = (graph: ReturnType<typeof launch>) => {
		for (const child of children(graph)) {
			expect(() => process.kill(child.pid, 0), `leaked ${child.role} PID ${child.pid}`).toThrow();
		}
	};
	return {
		port, value, index, redis, timelines, queues, graphs,
		async start() {
			const graph = launch('built/entrypoints/supervisor.js', config.path);
			graphs.push(graph);
			await graph.ready;
			expect(children(graph).map(child => child.role)).toEqual(['http', 'worker']);
			return graph;
		},
		async stop(graph: ReturnType<typeof launch>) {
			await stop(graph); gone(graph);
		},
		async stream(actor = 'root') {
			const stream = await websocket(port, actor);
			streams.push(stream);
			return stream;
		},
		async tasksApplied() {
			const tasks = await client.tasks.getTasks({ indexUids: [index.uid], limit: 1000 });
			for (const task of tasks.results) {
				expect((await client.tasks.waitForTask(task.uid, { timeout: 10000, interval: 20 })).status).toBe('succeeded');
			}
			return tasks.results.map(task => task.uid);
		},
		async close() {
			for (const stream of streams) {
				stream.socket.terminate();
			}
			try {
				for (const graph of graphs) {
					if (graph.child.exitCode === null && graph.child.signalCode === null) {
						graph.child.kill('SIGTERM');
					}
					await graph.exit;
					// Check before fallback cleanup so leaked children fail the test.
					try {
						gone(graph);
					} finally {
						for (const child of children(graph)) {
							try {
								process.kill(child.pid, 'SIGKILL');
							} catch { /* Already exited. */ }
						}
					}
				}
			} finally {
				for (const queue of queues) {
					await queue.obliterate({ force: true }); await queue.close();
				}
				redis.disconnect(); timelines.disconnect(); await config.close();
				const task = await index.delete().catch((error: unknown) => {
					expect(error).toMatchObject({ cause: { code: 'index_not_found' } });
					return null;
				});
				if (task) {
					await client.tasks.waitForTask(task);
				}
			}
		},
	};
}

async function controlPoll(port: number, operation: 'pause' | 'resume') {
	const response = await fetch(`http://127.0.0.1:${port}/api/admin/queue/${operation}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ i: seeded.actors.root.token, queue: 'endedPollNotification' }),
	});
	expect(response.status, await response.clone().text()).toBe(204);
}

function identity(job: { id?: string; name: string; data: unknown; opts: unknown }) {
	return structuredClone({ id: job.id, name: job.name, data: job.data, opts: job.opts });
}

async function delayedScore(queue: Queue, id: string) {
	const score = await (await queue.getBackend().client).zscore(queue.toKey('delayed'), id);
	expect(score).not.toBeNull();
	return Number(score);
}

function pollEnded(noteId: string) {
	return source.query("SELECT recipient_id, notifier_id FROM backend_internal.notification WHERE note_id=$1 AND notification_type='pollEnded'", [noteId]);
}

function noUnexpectedDiagnostics(graphs: ReturnType<typeof launch>[]) {
	for (const graph of graphs) {
		expect(graph.output()).not.toMatch(/note-post-save.failed|note-post-delete.failed|shutdown.timeout|search-\w+.failed|deliver.instance-update-failed|webhook.status-update-failed/);
	}
}

function jobFailures(graph: ReturnType<typeof launch>) {
	return graph.output().split('\n').filter(line => line.includes('"event":"job.failed"')).map(line => JSON.parse(line) as { queue: string; reason?: string; error?: { name: string } });
}

test('N7 Supervisor preserves HTTP-created posting work across stop/restart and natural retries', async () => {
	const f = await postingGraph();
	const [ap, webhook, pollQueue] = f.queues;
	inbox.respond('/inbox/remote', 503);
	hookStatuses.set('author-hook', 429);
	try {
		const first = await f.start();
		const author = await f.stream('ordinary');
		const viewer = await f.stream();
		await controlPoll(f.port, 'pause');
		expect(await pollQueue.isPaused()).toBe(true);
		const tag = `retry${randomUUID().replaceAll('-', '')}`;
		const text = `@root #${tag} restart poll`;
		const startedAt = Date.now();
		const response = await api(f.port, 'create', { text, visibility: 'public', poll: { choices: ['one', 'two'], expiredAfter: 3000 } });
		const finishedAt = Date.now();
		expect(response.status, await response.clone().text()).toBe(200);
		const { createdNote } = await response.json() as { createdNote: { id: string; poll: { expiresAt: string } } };
		const noteId = createdNote.id;
		const row = await source.getRepository(MiNote).findOneByOrFail({ id: noteId });
		const poll = await source.getRepository(MiPoll).findOneByOrFail({ noteId });
		expect(row).toMatchObject({ userId: seeded.actors.ordinary.id, text, visibility: 'public', hasPoll: true, tags: [tag], mentions: [seeded.actors.root.id] });
		expect(poll).toMatchObject({ choices: ['one', 'two'], votes: [0, 0], multiple: false, userId: row.userId, noteVisibility: 'public' });
		const expiry = poll.expiresAt!.getTime();
		expect(expiry).toBe(new Date(createdNote.poll.expiresAt).getTime());
		expect(expiry).toBeGreaterThanOrEqual(startedAt + 3000);
		expect(expiry).toBeLessThanOrEqual(finishedAt + 3000);
		const shown = await api(f.port, 'show', { noteId });
		expect(shown.status).toBe(200);
		expect(await shown.json()).toMatchObject({ id: noteId, text, poll: { expiresAt: poll.expiresAt!.toISOString() } });
		await vi.waitFor(async () => {
			for (const type of ['note', 'mention', 'notification']) {
				expect(viewer.messages.some(m => m.body.type === type && (m.body.body?.id === noteId || m.body.body?.note?.id === noteId))).toBe(true);
			}
			expect(await source.query('SELECT notification_type FROM backend_internal.notification WHERE note_id=$1', [noteId])).toEqual([{ notification_type: 'mention' }]);
			expect(await f.timelines.lrange('list:localTimeline', 0, -1)).toContain(noteId);
			expect(await f.timelines.lrange(`list:homeTimeline:${seeded.actors.root.id}`, 0, -1)).toContain(noteId);
			expect(await f.redis.sismember(`hashtagUsers:${tag}`, row.userId)).toBe(1);
			expect((await f.index.getDocument(noteId)).text).toBe(text);
		}, { timeout: 15000, interval: 30 });
		await f.tasksApplied();
		await vi.waitFor(async () => {
			for (const queue of [ap, webhook]) {
				expect((await queue.getJobs(['delayed'])).filter(j => queue === ap ? j.data.content.includes(noteId) : j.data.webhookId === 'author-hook' && j.data.content.note.id === noteId)).toHaveLength(1);
			}
		}, { timeout: 10000 });
		const apJob = (await ap.getJobs(['delayed'])).find(j => j.data.content.includes(noteId))!;
		const hookJob = (await webhook.getJobs(['delayed'])).find(j => j.data.webhookId === 'author-hook' && j.data.content.note.id === noteId)!;
		const pollJob = (await pollQueue.getJobs(['delayed', 'waiting'])).find(j => j.data.noteId === noteId)!;
		expect(pollJob).toBeDefined();
		expect(pollJob.name).toBe(noteId);
		expect(pollJob.data).toEqual({ noteId });
		expect(pollJob.opts.delay).toBeGreaterThan(0);
		expect(pollJob.opts).toMatchObject({ removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } });
		// Queue timestamp is taken just after the expiry-derived delay is computed.
		expect(pollJob.timestamp + pollJob.opts.delay!).toBeGreaterThanOrEqual(expiry);
		expect(pollJob.timestamp + pollJob.opts.delay!).toBeLessThan(expiry + 1000);
		const saved = [apJob, hookJob, pollJob].map(identity);
		const scores: number[] = [];
		for (const [queue, job, attempts] of [[ap, apJob, 12], [webhook, hookJob, 4]] as const) {
			expect(job.attemptsMade).toBe(1);
			expect(job.delay).toBeGreaterThanOrEqual(60000);
			expect(job.delay).toBeLessThanOrEqual(72000);
			expect(job.opts).toMatchObject({ attempts, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } });
			scores.push(await delayedScore(queue, job.id!));
		}
		expect(deliveries(noteId)).toHaveLength(1);
		expect(deliveries(noteId)[0].verify(publicKeyPem)).toEqual({ signature: true, digest: true });
		expect(deliveries(noteId)[0].body).toBe(apJob.data.content);
		expect(deliveries(noteId)[0].headers.digest).toBe(apJob.data.digest);
		expect(receipts(noteId).filter(r => r.hookId === 'viewer-hook').map(r => r.type)).toEqual(['mention']);
		const firstHook = receipts(noteId).find(r => r.hookId === 'author-hook')!;
		expect(firstHook).toMatchObject({ secret: 'test-only', server: f.value.url, userId: row.userId, eventId: hookJob.data.eventId, createdAt: hookJob.data.createdAt, body: hookJob.data.content });
		expect(firstHook.raw).toBe(JSON.stringify({ server: f.value.url, hookId: 'author-hook', userId: row.userId, eventId: hookJob.data.eventId, createdAt: hookJob.data.createdAt, type: 'note', body: hookJob.data.content }));
		await f.stop(first);
		expect(Date.now()).toBeLessThan(Math.min(...scores.map(score => Math.floor(score / 4096))));
		for (const [i, queue] of f.queues.entries()) {
			const retained = (await queue.getJob(saved[i].id!))!;
			expect(identity(retained)).toEqual(saved[i]);
			expect(retained.attemptsMade).toBe(i === 2 ? 0 : 1);
			if (i < 2) {
				expect(await delayedScore(queue, retained.id!)).toBe(scores[i]);
			}
		}
		expect(await source.getRepository(MiNote).findOneByOrFail({ id: noteId })).toEqual(row);
		expect(await source.getRepository(MiPoll).findOneByOrFail({ noteId })).toEqual(poll);
		expect(await pollEnded(noteId)).toEqual([]);
		inbox.respond('/inbox/remote', 202); hookStatuses.delete('author-hook');
		const second = await f.start();
		const reconnected = await f.stream('ordinary');
		await vi.waitFor(() => expect(author.socket.readyState).toBe(WebSocket.CLOSED));
		expect((await api(f.port, 'show', { noteId })).status).toBe(200);
		if (Date.now() < expiry) {
			await new Promise(resolve => setTimeout(resolve, expiry - Date.now()));
		}
		expect(await pollEnded(noteId)).toEqual([]);
		expect(await pollQueue.isPaused()).toBe(true);
		await controlPoll(f.port, 'resume');
		await vi.waitFor(async () => {
			expect(await pollEnded(noteId)).toEqual([{ recipient_id: row.userId, notifier_id: null }]);
			expect(reconnected.messages.some(m => m.body.type === 'notification' && m.body.body?.type === 'pollEnded' && m.body.body.note?.id === noteId)).toBe(true);
			expect(await (await pollQueue.getJob(pollJob.id!))!.getState()).toBe('completed');
		}, { timeout: 10000 });
		expect(identity((await pollQueue.getJob(pollJob.id!))!)).toEqual(saved[2]);
		// Both real failures retry concurrently after their original natural deadlines.
		await vi.waitFor(async () => {
			for (const [queue, id] of [[ap, apJob.id!], [webhook, hookJob.id!]] as const) {
				const job = (await queue.getJob(id))!;
				expect(await job.getState()).toBe('completed'); expect(job.attemptsMade).toBe(2);
			}
		}, { timeout: 85000, interval: 100 });
		for (const [i, queue] of [ap, webhook].entries()) {
			expect(identity((await queue.getJob(saved[i].id!))!)).toEqual(saved[i]);
		}
		const apReceipts = deliveries(noteId);
		expect(apReceipts).toHaveLength(2);
		const hookReceipts = receipts(noteId).filter(r => r.hookId === 'author-hook');
		expect(hookReceipts).toHaveLength(2);
		expect(apReceipts[1].receivedAt).toBeGreaterThanOrEqual(Math.floor(scores[0] / 4096));
		expect(hookReceipts[1].receivedAt).toBeGreaterThanOrEqual(Math.floor(scores[1] / 4096));
		for (const pair of [apReceipts, hookReceipts]) {
			expect(pair[1].receivedAt - pair[0].receivedAt).toBeGreaterThanOrEqual(60000);
		}
		for (const receipt of apReceipts) {
			expect(receipt.verify(publicKeyPem)).toEqual({ signature: true, digest: true });
			expect(receipt.keyId).toBe(`${f.value.url}/users/${row.userId}#main-key`);
			expect(receipt.body).toBe(apJob.data.content); expect(receipt.headers.digest).toBe(apJob.data.digest);
		}
		expect(hookReceipts[1].raw).toBe(firstHook.raw); expect(hookReceipts[1].secret).toBe(firstHook.secret);
		await queueIdle(f.queues);
		// Existing full deletion cases remain the primary proof. Reuse their helpers
		// here with the history snapshot taken AFTER pollEnded; WS is newly live.
		await reconnected.subscribe(noteId);
		const before = await history(noteId, tag, f.redis, f.timelines);
		const beforeHooks = structuredClone(receipts(noteId));
		expect((await api(f.port, 'delete', { noteId })).status).toBe(204);
		await vi.waitFor(() => expect(reconnected.messages.find(m => m.type === 'noteUpdated')).toMatchObject({ body: { id: noteId, type: 'deleted' } }));
		await vi.waitFor(async () => {
			expect(deliveries(noteId).map(d => JSON.parse(d.body).type)).toEqual(['Create', 'Create', 'Delete']);
			await expect(f.index.getDocument(noteId)).rejects.toMatchObject({ cause: { code: 'document_not_found' } });
		}, { timeout: 10000 });
		await queueIdle(f.queues); await f.stop(second); await f.tasksApplied();
		expect(await source.getRepository(MiNote).existsBy({ id: noteId })).toBe(false);
		expect(await source.getRepository(MiPoll).existsBy({ noteId })).toBe(false);
		expect(await history(noteId, tag, f.redis, f.timelines)).toEqual(before);
		expect(receipts(noteId)).toEqual(beforeHooks);
		expect(deliveries(noteId).map(d => JSON.parse(d.body).type)).toEqual(['Create', 'Create', 'Delete']);
		expect(deliveries(noteId)[2].verify(publicKeyPem)).toEqual({ signature: true, digest: true });
		await expect(f.index.getDocument(noteId)).rejects.toMatchObject({ cause: { code: 'document_not_found' } });
		const third = await f.start();
		const missing = await api(f.port, 'show', { noteId });
		expect(missing.status).toBe(400); expect(await missing.json()).toMatchObject({ error: { code: 'NO_SUCH_NOTE' } });
		await f.stop(third); noUnexpectedDiagnostics(f.graphs);
		expect(jobFailures(first).map(entry => entry.queue).sort()).toEqual(['deliver', 'userWebhookDeliver']);
		expect(jobFailures(second)).toEqual([]); expect(jobFailures(third)).toEqual([]);
	} finally {
		inbox.respond('/inbox/remote', 202); hookStatuses.clear(); await f.close();
	}
}, 180000);

async function postingState(f: Awaited<ReturnType<typeof postingGraph>>) {
	await f.tasksApplied();
	const values = async (redis: Redis, pattern: string, prefix: string) => {
		const keys = (await redis.keys(pattern)).sort();
		return Promise.all(keys.map(async key => ({ key, value: await redis.dump(key.slice(prefix.length)) })));
	};
	return {
		notes: await source.getRepository(MiNote).count(), polls: await source.getRepository(MiPoll).count(),
		authorCount: (await source.getRepository(MiUser).findOneByOrFail({ id: seeded.actors.ordinary.id })).notesCount,
		notifications: await source.query('SELECT * FROM backend_internal.notification ORDER BY notification_id'),
		hashtags: await source.getRepository(MiHashtag).find({ order: { name: 'ASC' } }),
		hashtagUsers: await values(f.redis, `${f.value.redis.keyPrefix}hashtagUsers:*`, f.value.redis.keyPrefix!),
		rankings: await values(f.redis, `${f.value.redis.keyPrefix}featuredHashtagsRanking:*`, f.value.redis.keyPrefix!),
		timelines: await values(f.timelines, `${f.value.redisForTimelines!.keyPrefix}list:*`, f.value.redisForTimelines!.keyPrefix!),
		jobs: await Promise.all(f.queues.map(async queue => (await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])).map(identity).sort((a, b) => a.id!.localeCompare(b.id!)))),
		// Concurrent startup settings submissions are unrelated to posting. Compare
		// every other accepted task, including document additions/deletions.
		tasks: (await client.tasks.getTasks({ indexUids: [f.index.uid], limit: 1000 })).results.filter(task => task.type !== 'settingsUpdate').map(task => task.uid),
		documents: (await f.index.getDocuments()).results,
		hooks: structuredClone(hooks), inboxCount: inbox.deliveries.length,
	};
}

test('N7 Supervisor rejects credentials and rolls back Poll failure without posting effects', async () => {
	const f = await postingGraph();
	const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
	const moved = { id: seeded.codec.newId(Date.now()), token: 'movedn7'.padEnd(16, '0') };
	await source.getRepository(MiUser).insert({ id: moved.id, token: moved.token, username: 'movedn7', usernameLower: 'movedn7', movedToUri: 'https://moved.example/users/n7' });
	let trigger = false;
	try {
		const graph = await f.start();
		const observer = await f.stream();
		// Await index availability and applied settings, without depending on how
		// many adapters submit startup settings in this process graph.
		await vi.waitFor(async () => expect((await f.index.getStats()).numberOfDocuments).toBe(0), { timeout: 10000 });
		const before = await postingState(f);
		const streamStart = observer.messages.length;
		for (const [name, token] of [
			['C2-guest', null], ['C2-invalid', 'invalid-n7-token'], ['C2-suspended', seeded.actors.suspended.token],
			['C2-moved', moved.token], ['C2-no-scope', seeded.actors.ordinaryNoScope.token],
		] as const) {
			const response = await fetch(`http://127.0.0.1:${f.port}/api/notes/create`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				// Invalid input still yields the named credential rejection first.
				body: JSON.stringify({ i: token, text: 42, poll: { choices: [] } }),
			});
			expect({ status: response.status, body: await response.json(), wwwAuthenticate: response.headers.get('www-authenticate') }, name).toEqual({ status: golden[name].status, body: golden[name].body, wwwAuthenticate: golden[name].wwwAuthenticate });
			expect({ notes: await source.getRepository(MiNote).count() - before.notes, polls: await source.getRepository(MiPoll).count() - before.polls }, name).toEqual(golden[name].delta);
		}
		// Fixed upstream NoteCreateService inserts Note/Poll in one transaction,
		// before post-save effects. Inject at the second INSERT, not at a double.
		await source.query("CREATE FUNCTION n7_reject_poll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF 'fail-poll-n7' = ANY(NEW.choices) THEN RAISE EXCEPTION 'injected Poll insert failure'; END IF; RETURN NEW; END $$");
		await source.query('CREATE TRIGGER n7_reject_poll BEFORE INSERT ON poll FOR EACH ROW EXECUTE FUNCTION n7_reject_poll()');
		trigger = true;
		try {
			const failed = await api(f.port, 'create', { text: '@root #rollbackn7 rollback', poll: { choices: ['fail-poll-n7', 'two'], expiredAfter: 3000 } });
			expect(failed.status).toBe(500);
		} finally {
			await source.query('DROP TRIGGER n7_reject_poll ON poll');
			await source.query('DROP FUNCTION n7_reject_poll()');
			trigger = false;
		}
		// Graceful shutdown drains accepted producers and handlers. Absence is
		// measured after that barrier, not inferred from a brief receipt timeout.
		await f.stop(graph);
		expect(await postingState(f)).toEqual(before);
		expect(observer.messages.slice(streamStart).filter(m => m.type === 'noteUpdated' || m.type === 'channel' && ['note', 'mention', 'notification'].includes(m.body.type ?? ''))).toEqual([]);
		noUnexpectedDiagnostics(f.graphs);
		expect(graph.output()).not.toContain('job.failed');
	} finally {
		if (trigger) {
			await source.query('DROP TRIGGER n7_reject_poll ON poll');
			await source.query('DROP FUNCTION n7_reject_poll()');
		}
		await f.close();
	}
});

test('N7 Supervisor keeps terminal AP 404 failed without recreating the post', async () => {
	const f = await postingGraph();
	inbox.respond('/inbox/remote', 404);
	try {
		const graph = await f.start();
		const viewer = await f.stream();
		const before = (await source.getRepository(MiUser).findOneByOrFail({ id: seeded.actors.ordinary.id })).notesCount;
		const tag = `terminal${randomUUID().replaceAll('-', '')}`;
		const text = `@root #${tag} terminal AP`;
		const response = await api(f.port, 'create', { text });
		expect(response.status, await response.clone().text()).toBe(200);
		const noteId = (await response.json() as { createdNote: { id: string } }).createdNote.id;
		const show = await api(f.port, 'show', { noteId });
		expect(show.status).toBe(200); expect(await show.json()).toMatchObject({ id: noteId, text });
		const [ap, webhook, poll] = f.queues;
		await vi.waitFor(async () => {
			expect(await ap.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 1, completed: 0 });
			expect((await f.index.getDocument(noteId)).text).toBe(text);
			expect(receipts(noteId).map(r => r.type).sort()).toEqual(['mention', 'note']);
			expect(viewer.messages.some(m => m.body.type === 'notification' && m.body.body?.note?.id === noteId)).toBe(true);
			expect(await f.timelines.lrange('list:localTimeline', 0, -1)).toContain(noteId);
			expect(await f.redis.sismember(`hashtagUsers:${tag}`, seeded.actors.ordinary.id)).toBe(1);
		}, { timeout: 15000 });
		await queueIdle([webhook, poll]); await f.tasksApplied();
		await f.stop(graph);
		const jobs = await ap.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
		expect(jobs).toHaveLength(1);
		expect(await jobs[0].getState()).toBe('failed');
		expect(jobs[0].attemptsMade).toBe(1); expect(jobs[0].opts.attempts).toBe(12);
		expect(jobs[0].failedReason).toBe('404 Not Found');
		expect(jobFailures(graph)).toEqual([expect.objectContaining({ queue: 'deliver', reason: '404 Not Found', error: expect.objectContaining({ name: 'UnrecoverableError' }) })]);
		expect(deliveries(noteId)).toHaveLength(1);
		expect(deliveries(noteId)[0].verify(publicKeyPem)).toEqual({ signature: true, digest: true });
		expect(await source.getRepository(MiNote).findOneByOrFail({ id: noteId })).toMatchObject({ text, userId: seeded.actors.ordinary.id });
		expect(await source.getRepository(MiNote).countBy({ text })).toBe(1);
		expect((await source.getRepository(MiUser).findOneByOrFail({ id: seeded.actors.ordinary.id })).notesCount).toBe(before + 1);
		expect(await source.query('SELECT notification_type FROM backend_internal.notification WHERE note_id=$1', [noteId])).toEqual([{ notification_type: 'mention' }]);
		noUnexpectedDiagnostics(f.graphs);
	} finally {
		inbox.respond('/inbox/remote', 202); await f.close();
	}
});
