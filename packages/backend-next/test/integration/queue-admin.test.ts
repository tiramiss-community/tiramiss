/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Queue, Worker } from 'bullmq';
import { MiAccessToken, MiApp, MiModerationLog, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { baseQueueOptions, baseWorkerOptions } from '../../src/platform/job-queue/connection.js';
import { createDeliverQueue, startDeliverWorker } from '../../src/platform/job-queue/deliver.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { openQueueHttp } from '../../src/composition/queue-http.js';
import type { QueueName } from '../../src/modules/queue/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let queueHttp: Awaited<ReturnType<typeof openQueueHttp>>;
let server: Awaited<ReturnType<typeof listenHttp>>;
let url: string;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
const errors: { event: string; fields?: Record<string, unknown> }[] = [];
const queues = new Map<QueueName, Queue>();
const names = ['system', 'endedPollNotification', 'postScheduledNote', 'deliver', 'inbox', 'db', 'relationship', 'objectStorage', 'userWebhookDeliver', 'systemWebhookDeliver'] as const;
const tokens: Record<string, string> = {};
const logger = {
	info() { }, error(event: string, fields?: Record<string, unknown>) {
		errors.push({ event, fields });
	}
};

function queue(name: QueueName) {
	if (!queues.has(name)) {
		queues.set(name, new Queue(name, baseQueueOptions(database.config.redisForJobQueue, name, 5000)));
	}
	return queues.get(name)!;
}

async function request(operation: string, input: object = {}, token: string | null = seeded.actors.root.token, headers: Record<string, string> = {}) {
	return fetch(`${url}/api/admin/queue/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...input, ...(token === null ? {} : { i: token }) }) });
}

function deferred() {
	let resolve!: () => void; const promise = new Promise<void>(done => {
		resolve = done;
	}); return { promise, resolve };
}

beforeAll(async () => {
	database = await createTestDatabase();
	database.config.redisForJobQueue = { ...database.config.redis, db: 1, prefix: `${database.config.redis.prefix}-queues` };
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, logger);
	seeded = await seedRoleHttp(resources.dataSource);
	for (const [name, permission] of [['read', ['read:admin:queue']], ['write', ['write:admin:queue']], ['none', []]] as const) {
		tokens[name] = `queue-access-${name}-token`;
		await resources.dataSource.getRepository(MiAccessToken).insert({ id: seeded.codec.newId(Date.now()), userId: seeded.actors.root.id, token: tokens[name], hash: `queue-${name}-hash`, permission: [...permission] });
	}
	const appId = seeded.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiApp).insert({ id: appId, name: 'queue-app', description: '', secret: 'test-only', permission: ['read:admin:queue'] });
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: seeded.codec.newId(Date.now()), userId: seeded.actors.root.id, appId, token: 'queue-app-test-token', hash: 'queue-app-test-hash', permission: ['write:admin:queue'] });
	tokens.app = 'QUEUE-APP-TEST-HASH';
	queueHttp = await openQueueHttp(resources, database.config, () => { });
	server = await listenHttp(createBackendHttpApp(resources, database.config, queueHttp.api), database.config.http);
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
	errors.length = 0; for (const q of queues.values()) {
		await q.obliterate({ force: true });
	}
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} await queueHttp?.close(); for (const q of queues.values()) {
		await q.obliterate({ force: true }); await q.close();
	} await resources?.close(); await database?.close();
});

test('normal HTTP app registers the source queue routes', async () => {
	const response = await fetch(`${url}/api/admin/queue/queues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.root.token }) });
	expect(response.status).toBe(200);
	expect((await response.json() as { name: string }[]).map(q => q.name)).toEqual(['system', 'endedPollNotification', 'postScheduledNote', 'deliver', 'inbox', 'db', 'relationship', 'objectStorage', 'userWebhookDeliver', 'systemWebhookDeliver']);
});

test.each(names)('every source selector reads only %s, including queues without workers', async name => {
	const job = await queue(name).add('plain retained job', { marker: name, secret: 'top-secret', nested: { secret: 'nested-visible' } });
	await job.log('log-secret-visible');
	const response = await request('show-job', { queue: name, jobId: job.id });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ id: job.id, name: 'plain retained job', attempts: 0, isFailed: false, data: { marker: name, secret: name.endsWith('WebhookDeliver') ? '(redacted)' : 'top-secret', nested: { secret: 'nested-visible' } } });
	expect(await (await request('show-job-logs', { queue: name, jobId: job.id })).json()).toEqual(['log-secret-visible']);
	expect(await job.getState()).toBe('waiting');
});

test.each([
	['absent', null, 401, 'CREDENTIAL_REQUIRED'], ['invalid', 'invalid-token', 401, 'AUTHENTICATION_FAILED'],
	['ordinary', 'ordinary', 403, 'ROLE_PERMISSION_DENIED'], ['expired', 'expired', 403, 'ROLE_PERMISSION_DENIED'],
	['suspended', 'suspended', 403, 'YOUR_ACCOUNT_SUSPENDED'], ['none', 'none', 403, 'PERMISSION_DENIED'],
	['read', 'read', 403, 'PERMISSION_DENIED'],
] as const)('%s credentials reject a write before malformed queue input', async (_name, who, status, code) => {
	const token = who === null ? null : tokens[who] ?? seeded.actors[who]?.token ?? who;
	const response = await request('pause', { queue: 'invalid' }, token);
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject({ error: { code } });
});

test.each(['root', 'moderator', 'administrator'])('%s native credentials may write and read', async who => {
	const response = await request('pause', { queue: 'system' }, seeded.actors[who].token);
	expect(response.status).toBe(204);
	expect(await queue('system').isPaused()).toBe(true);
	expect((await request('queues', {}, seeded.actors[who].token)).status).toBe(200);
});

test('access and application scopes, Bearer precedence and method/body boundaries', async () => {
	expect((await request('queues', {}, tokens.read)).status).toBe(200);
	expect((await request('queues', {}, tokens.write)).status).toBe(403);
	expect((await request('pause', { queue: 'system' }, tokens.write)).status).toBe(204);
	expect((await request('queues', {}, tokens.app)).status).toBe(200);
	expect((await request('pause', { queue: 'system' }, tokens.app)).status).toBe(403);
	expect((await request('queues', {}, 'invalid-token', { Authorization: `Bearer ${seeded.actors.root.token}` })).status).toBe(200);
	expect((await request('queues', {}, seeded.actors.root.token, { Authorization: 'Bearer invalid-token' })).status).toBe(401);
	expect((await request('queues', { i: 1 }, null)).status).toBe(400);
	expect((await fetch(`${url}/api/admin/queue/queues`)).status).toBe(405);
	expect((await fetch(`${url}/api/admin/queue/queues`, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
	expect((await fetch(`${url}/api/admin/queue/queues`, { method: 'POST', body: ' '.repeat(1024 * 1024 + 1) })).status).toBe(413);
});

test('fresh moderator revocation and conditional roles affect the next operation', async () => {
	const assignment = await resources.dataSource.getRepository(MiRoleAssignment).findOneByOrFail({ userId: seeded.actors.moderator.id });
	await resources.dataSource.getRepository(MiRoleAssignment).delete(assignment.id);
	try {
		expect((await request('queues', {}, seeded.actors.moderator.token)).status).toBe(403);
	} finally {
		await resources.dataSource.getRepository(MiRoleAssignment).insert(assignment);
	}
	const id = seeded.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiRole).insert({ id, name: 'conditional', description: '', target: 'conditional', isModerator: true, condFormula: { id: 'condition', type: 'isLocal' }, updatedAt: new Date(), lastUsedAt: new Date() });
	try {
		expect((await request('pause', { queue: 'system' }, seeded.actors.ordinary.token)).status).toBe(204);
	} finally {
		await resources.dataSource.getRepository(MiRole).delete(id);
	}
	expect((await request('pause', { queue: 'system' }, seeded.actors.ordinary.token)).status).toBe(403);
});

test('real inclusive pages return101, search returns100 after webhook redaction', async () => {
	const q = queue('systemWebhookDeliver');
	await q.addBulk(Array.from({ length: 1002 }, (_, i) => ({ name: `Search Target ${i}`, data: { secret: 'needle-secret', content: 'visible-body' } })));
	const list = async (extra: object) => (await request('jobs', { queue: 'systemWebhookDeliver', state: ['wait'], ...extra })).json() as Promise<any[]>;
	expect((await list({}))).toHaveLength(101);
	expect((await list({ search: '' }))).toHaveLength(101);
	expect((await list({ search: 'SEARCH target' }))).toHaveLength(100);
	expect((await list({ search: 'needle-secret' }))).toEqual([]);
	expect((await list({ search: 'attempts visible-body' }))).toHaveLength(100);
	expect((await request('jobs', { queue: 'systemWebhookDeliver', state: [], limit: 1, offset: 99 })).status).toBe(200);
});

test('delayed host groups, four queue stats and INFO details come from the queue Redis', async () => {
	await queue('deliver').addBulk([{ name: 'd1', data: { to: 'https://remote.example:8443/inbox' }, opts: { delay: 600000 } }, { name: 'd2', data: { to: 'https://remote.example:8443/other' }, opts: { delay: 600000 } }]);
	await queue('inbox').add('i', { signature: { keyId: 'https://signer.example/key' } }, { delay: 600000 });
	expect(await (await request('deliver-delayed')).json()).toEqual([['remote.example:8443', 2]]);
	expect(await (await request('inbox-delayed')).json()).toEqual([['signer.example', 1]]);
	const stats = await (await request('stats')).json() as Record<string, any>;
	expect(Object.keys(stats)).toEqual(['deliver', 'inbox', 'db', 'objectStorage']);
	expect(stats.deliver.delayed).toBe(2);
	const details = await (await request('queue-stats', { queue: 'deliver' })).json() as any;
	expect(details).toMatchObject({ name: 'deliver', qualifiedName: `${database.config.redisForJobQueue.prefix}:queue:deliver:deliver`, counts: { delayed: 2 }, isPaused: false, db: { mode: 'standalone', port: 6379 } });
	expect(details.metrics).toHaveProperty('completed.data');
	expect(Number.isInteger(details.db.memory.fragmentationRatio)).toBe(true);
});

test('missing jobs, queue isolation and remove/clear leave foreign prefixes intact', async () => {
	const q = queue('relationship');
	const foreign = new Queue('relationship', baseQueueOptions({ ...database.config.redisForJobQueue, prefix: `${database.config.redis.prefix}-foreign` }, 'relationship', 5000));
	try {
		const job = await q.add('selected', {}, { jobId: 'same-id' });
		await foreign.add('foreign', {}, { jobId: 'same-id' });
		expect((await request('show-job', { queue: 'db', jobId: job.id })).status).toBe(500);
		expect((await request('retry-job', { queue: 'db', jobId: job.id })).status).toBe(204);
		expect((await request('remove-job', { queue: 'db', jobId: job.id })).status).toBe(204);
		expect(await (await request('show-job-logs', { queue: 'db', jobId: 'absent' })).json()).toEqual([]);
		expect((await request('remove-job', { queue: 'relationship', jobId: job.id })).status).toBe(204);
		await vi.waitFor(async () => expect(await q.getJob(job.id!)).toBeUndefined());
		await q.add('wait', {}); await q.add('delayed', {}, { delay: 600000 });
		expect((await request('clear', { queue: 'relationship', state: '*' })).status).toBe(204);
		await vi.waitFor(async () => expect(await q.getJobCounts('wait', 'delayed')).toEqual({ wait: 0, delayed: 0 }));
		expect(await foreign.getJob('same-id')).toBeDefined();
	} finally {
		await foreign.obliterate({ force: true }); await foreign.close();
	}
});

test('promote and retry unfinished jobs move delayed jobs back to waiting', async () => {
	const q = queue('db');
	const first = await q.add('promote', {}, { delay: 600000 });
	const second = await q.add('retry', {}, { delay: 600000 });
	expect((await request('retry-job', { queue: 'db', jobId: second.id })).status).toBe(204);
	await vi.waitFor(async () => expect(await second.getState()).toBe('waiting'));
	expect((await request('promote-jobs', { queue: 'db' })).status).toBe(204);
	await vi.waitFor(async () => expect(await first.getState()).toBe('waiting'));
});

test('global pause preserves waiting work, lets active work finish, and resume runs the next job', async () => {
	const q = queue('objectStorage');
	const entered = deferred(); const release = deferred();
	const seen: string[] = [];
	await request('pause', { queue: 'objectStorage' });
	const first = await q.add('first', {}); const second = await q.add('second', {});
	const worker = new Worker('objectStorage', async job => {
		seen.push(job.name); if (job.name === 'first') {
			entered.resolve(); await release.promise;
		} return 'done';
	}, baseWorkerOptions(database.config.redisForJobQueue, 'objectStorage', 5000));
	try {
		await worker.waitUntilReady();
		expect(await q.isPaused()).toBe(true); expect(await first.getState()).toBe('waiting'); expect(seen).toEqual([]);
		await request('resume', { queue: 'objectStorage' }); await entered.promise;
		await request('pause', { queue: 'objectStorage' }); release.resolve();
		await vi.waitFor(async () => expect(await first.getState()).toBe('completed'));
		expect(seen).toEqual(['first']); expect(await second.getState()).toBe('waiting');
		await request('resume', { queue: 'objectStorage' });
		await vi.waitFor(async () => expect(await second.getState()).toBe('completed'));
		expect(seen).toEqual(['first', 'second']);
		const history = await (await request('show-job', { queue: 'objectStorage', jobId: first.id })).json();
		expect(history).toMatchObject({ returnValue: 'done', isFailed: false, attempts: 1 });
		expect((await request('clear', { queue: 'objectStorage', state: 'completed' })).status).toBe(204);
		await vi.waitFor(async () => expect((await q.getJobCounts('completed')).completed).toBe(0));
	} finally {
		release.resolve(); await worker.close();
	}
});

test('real deliver producer/worker retries an administratively retried failed payload against a delivery target', async () => {
	const payloads: unknown[] = [];
	let fail = true;
	const target = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) {
			chunks.push(chunk);
		} payloads.push(JSON.parse(Buffer.concat(chunks).toString())); res.statusCode = fail ? 503 : 202; res.end();
	});
	target.listen(0, '127.0.0.1'); await once(target, 'listening');
	const to = `http://127.0.0.1:${(target.address() as { port: number }).port}/inbox`;
	const producer = createDeliverQueue({ redis: database.config.redisForJobQueue, connectTimeoutMs: 5000, logger, onLost() { }, deliverJobMaxAttempts: 1 });
	await producer.ready();
	const stop = await startDeliverWorker({
		redis: database.config.redisForJobQueue, connectTimeoutMs: 5000, logger, config: { deliverJobConcurrency: 1 }, reportFailure() { }, process: async job => {
			const response = await fetch(job.to, { method: 'POST', body: job.content });
			return response.ok ? { kind: 'done', result: 'Success' } : { kind: 'retry', error: new Error('fake target rejected') };
		}
	});
	try {
		await producer.deliverOne({ user: { id: seeded.actors.root.id }, activity: { type: 'Create', id: 'queue-retry-payload' }, to, isSharedInbox: false });
		const q = queue('deliver');
		await vi.waitFor(async () => expect((await q.getJobCounts('failed')).failed).toBe(1));
		const [failed] = await q.getJobs(['failed']); await failed.log('failed once');
		expect(await (await request('show-job', { queue: 'deliver', jobId: failed.id })).json()).toMatchObject({ isFailed: true, attempts: 1, failedReason: 'fake target rejected' });
		await request('pause', { queue: 'deliver' }); fail = false;
		expect((await request('retry-job', { queue: 'deliver', jobId: failed.id })).status).toBe(204);
		await vi.waitFor(async () => expect(await failed.getState()).toBe('waiting'));
		expect(payloads).toHaveLength(1);
		await request('resume', { queue: 'deliver' });
		await vi.waitFor(async () => expect(await failed.getState()).toBe('completed'));
		expect(payloads).toEqual([{ type: 'Create', id: 'queue-retry-payload' }, { type: 'Create', id: 'queue-retry-payload' }]);
		expect(await (await request('show-job-logs', { queue: 'deliver', jobId: failed.id })).json()).toEqual(['failed once']);
		expect(await (await request('show-job', { queue: 'deliver', jobId: failed.id })).json()).toMatchObject({ attempts: 2, returnValue: 'Success' });
		const details = await (await request('queue-stats', { queue: 'deliver' })).json() as any;
		expect(details.metrics.completed.meta.count).toBe(1); expect(details.metrics.failed.meta.count).toBe(1);
	} finally {
		await stop(); await producer.close(); await new Promise<void>(resolve => target.close(() => resolve()));
	}
});

test('locked active remove acknowledges204, logs detached failure, and preserves the job', async () => {
	const q = queue('db'); const entered = deferred(); const release = deferred();
	const worker = new Worker('db', async () => {
		entered.resolve(); await release.promise;
	}, baseWorkerOptions(database.config.redisForJobQueue, 'db', 5000));
	try {
		const job = await q.add('locked', {}); await entered.promise;
		expect((await request('remove-job', { queue: 'db', jobId: job.id })).status).toBe(204);
		await vi.waitFor(() => expect(errors.some(e => e.event === 'queue-admin.detached-failed' && e.fields?.operation === 'remove-job')).toBe(true));
		expect(await job.getState()).toBe('active');
	} finally {
		release.resolve(); await worker.close();
	}
});

test('audit uses only source event and actor, and audit failure leaves successful pause acknowledged', async () => {
	await request('pause', { queue: 'system' }); await request('resume', { queue: 'system' }); await request('promote-jobs', { queue: 'system' }); await request('clear', { queue: 'system', state: 'failed' });
	await vi.waitFor(async () => {
		const records = await resources.dataSource.getRepository(MiModerationLog).find({ where: { userId: seeded.actors.root.id }, order: { id: 'DESC' }, take: 4 });
		expect(new Set(records.map(row => row.type))).toEqual(new Set(['pauseQueue', 'resumeQueue', 'promoteQueue', 'clearQueue']));
		expect(records.map(row => row.info)).toEqual([{}, {}, {}, {}]);
	});
	await resources.dataSource.query(`CREATE FUNCTION reject_queue_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'pauseQueue' THEN RAISE EXCEPTION 'test queue audit failure'; END IF; RETURN NEW; END $$`);
	await resources.dataSource.query('CREATE TRIGGER reject_queue_audit BEFORE INSERT ON moderation_log FOR EACH ROW EXECUTE FUNCTION reject_queue_audit()');
	try {
		expect((await request('pause', { queue: 'system' })).status).toBe(204);
		expect(await queue('system').isPaused()).toBe(true);
		await vi.waitFor(() => expect(errors.some(e => e.event === 'queue-admin.detached-failed' && e.fields?.operation === 'audit')).toBe(true));
	} finally {
		await resources.dataSource.query('DROP TRIGGER reject_queue_audit ON moderation_log'); await resources.dataSource.query('DROP FUNCTION reject_queue_audit()');
	}
});
