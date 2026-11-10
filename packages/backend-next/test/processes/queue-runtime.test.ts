/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MiInstance, MiMeta, MiUser, MiUserKeypair, MiWebhook } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { toPuny } from '../../src/modules/federation/public.js';
import { deliverJobs } from '../../src/platform/job-queue/deliver.js';
import { userWebhookJob } from '../../src/platform/job-queue/user-webhook.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { startInboxRecorder } from '../helpers/outbound-http-fakes.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let inbox: Awaited<ReturnType<typeof startInboxRecorder>>;
const codec = createIdCodec('aidx');
const userId = codec.newId(Date.now() - 10000);

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	inbox = await startInboxRecorder();
	await source.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	await source.getRepository(MiUser).insert({ id: userId, username: 'runtime-worker', usernameLower: 'runtime-worker' });
	const pair = await generateRsaKeyPair();
	await source.getRepository(MiUserKeypair).insert({ userId, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
});
afterAll(async () => {
	await inbox?.close();
	await source?.destroy();
	await database?.close();
});

async function fixture(shutdownTimeoutMs = 5000) {
	const prefix = `queue-runtime-${randomUUID()}`;
	const config = {
		...database.config,
		http: { port: await freePort() },
		redis: { ...database.config.redis, prefix, keyPrefix: `${prefix}:`, connectionName: `${prefix}-dependencies` },
		redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:`, connectionName: `${prefix}-queue` },
		processes: { ...database.config.processes, shutdownTimeoutMs },
	};
	return { config, file: await configuration(config), control: new Redis(database.config.redis) };
}

async function bounded<T>(promise: Promise<T>, ms = 15000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Process observation exceeded ${ms}ms`)), ms);
		})]);
	} finally {
		clearTimeout(timer);
	}
}

async function message(child: ReturnType<typeof launch>, predicate: (value: any) => boolean) {
	await vi.waitFor(() => expect(child.messages.some(predicate), child.output()).toBe(true), { timeout: 10000, interval: 20 });
}

async function clients(control: Redis) {
	return String(await control.client('LIST')).split('\n');
}

test('producer-only normal HTTP shutdown releases every named queue client without starting workers', async () => {
	const f = await fixture();
	const baseline = (await clients(f.control)).filter(line => line.includes(`name=${f.config.redisForJobQueue.connectionName} `)).length;
	const child = launch('built/entrypoints/http.js', f.file.path);
	try {
		await child.ready;
		const live = await clients(f.control);
		expect(live.filter(line => line.includes(`name=${f.config.redisForJobQueue.connectionName} `)).length).toBeGreaterThan(baseline);
		expect(live.some(line => line.includes(f.config.redisForJobQueue.prefix) && line.includes('cmd=bzpopmin'))).toBe(false);
		child.child.kill('SIGTERM');
		expect((await bounded(child.exit)).code, child.output()).toBe(0);
		expect((await clients(f.control)).filter(line => line.includes(`name=${f.config.redisForJobQueue.connectionName} `))).toHaveLength(baseline);
	} finally {
		await child.close(); await f.control.quit(); await f.file.close();
	}
});

test.each(['http', 'worker'])('%s fails before ready when the business queue Redis is unavailable', async role => {
	const f = await fixture();
	const bad = await configuration({ ...f.config, redisForJobQueue: { ...f.config.redisForJobQueue, port: await freePort() } });
	const child = launch(`built/entrypoints/${role}.js`, bad.path);
	try {
		expect((await bounded(child.exit)).code, child.output()).toBe(1);
		expect(child.messages.some((m: any) => m.type === 'ready')).toBe(false);
		expect((await clients(f.control)).some(line => line.includes(`name=${f.config.redis.connectionName} `))).toBe(false);
	} finally {
		await child.close(); await bad.close(); await f.control.quit(); await f.file.close();
	}
});

test.each([
	['endedPollNotification', 'command'], ['deliver', 'command'], ['deliver', 'blocking'], ['userWebhookDeliver', 'blocking'],
] as const)('%s %s connection loss stops Supervisor siblings once without restart', async (queue, connection) => {
	const f = await fixture();
	const supervisor = launch('test/fixtures/queue-runtime-failure.mjs', f.file.path, { QUEUE_RUNTIME_SUPERVISOR: '1' });
	let children: { pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((m: any) => m.type === 'ready' && m.role === 'supervisor') as { children: typeof children }).children;
		await message(supervisor, m => m.type === 'fixture-connections' && m.queue === queue);
		const connections = supervisor.messages.find((m: any) => m.type === 'fixture-connections' && m.queue === queue) as Record<string, string>;
		expect(connections.command).not.toBe(connections.blocking);
		await f.control.client('KILL', 'ID', connections[connection]);
		expect((await bounded(supervisor.exit)).code, supervisor.output()).toBe(1);
		expect(supervisor.output()).toContain('JOB_QUEUE_REDIS_ENDED');
		expect(supervisor.output()).toContain(`"queue":"${queue}"`);
		expect(supervisor.messages.filter((m: any) => m.type === 'fixture-spawn')).toHaveLength(2);
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
		expect((await clients(f.control)).some(line => line.includes(f.config.redisForJobQueue.prefix))).toBe(false);
	} finally {
		await supervisor.close();
		for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
		await f.control.quit(); await f.file.close();
	}
});

test.each([
	['run-fulfilled', 'JOB_WORKER_STOPPED'], ['run-rejected', 'JOB_WORKER_FAILED'],
] as const)('unexpected %s reaches the normal worker failure path and Supervisor does not restart', async (mode, code) => {
	const f = await fixture();
	const supervisor = launch('test/fixtures/queue-runtime-failure.mjs', f.file.path, { QUEUE_RUNTIME_SUPERVISOR: '1', QUEUE_RUNTIME_FAILURE: mode });
	let children: { pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((m: any) => m.type === 'ready' && m.role === 'supervisor') as { children: typeof children }).children;
		supervisor.child.send({ type: 'settle-run' });
		expect((await bounded(supervisor.exit)).code, supervisor.output()).toBe(1);
		expect(supervisor.output()).toContain(code);
		expect(supervisor.output()).toContain('"queue":"deliver"');
		expect(supervisor.messages.filter((m: any) => m.type === 'fixture-spawn')).toHaveLength(2);
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		await supervisor.close();
		for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
		await f.control.quit(); await f.file.close();
	}
});

test('ordinary worker errors remain diagnostics and intentional shutdown stays successful', async () => {
	const f = await fixture();
	const child = launch('test/fixtures/queue-runtime-failure.mjs', f.file.path, { QUEUE_RUNTIME_FAILURE: 'diagnostic' });
	try {
		await child.ready;
		child.child.send({ type: 'emit-diagnostic' });
		await message(child, m => m.type === 'fixture-diagnostic');
		expect(child.child.exitCode).toBeNull();
		child.child.kill('SIGTERM');
		expect((await bounded(child.exit)).code, child.output()).toBe(0);
		expect(child.output()).not.toContain('runtime.failed');
	} finally {
		await child.close(); await f.control.quit(); await f.file.close();
	}
});

test.each(['startup-run-fulfilled', 'partial-startup'] as const)('%s prevents readiness and closes already opened workers and dependencies', async mode => {
	const f = await fixture();
	const child = launch('test/fixtures/queue-runtime-failure.mjs', f.file.path, { QUEUE_RUNTIME_FAILURE: mode });
	try {
		expect((await bounded(child.exit)).code, child.output()).toBe(1);
		expect(child.messages.some((m: any) => m.type === 'ready')).toBe(false);
		expect(child.messages.filter((m: any) => m.type === 'fixture-worker-closed').length).toBeGreaterThan(0);
		expect((await clients(f.control)).some(line => line.includes(f.config.redisForJobQueue.prefix))).toBe(false);
		expect(await source.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()')).toEqual([{ count: 1 }]);
		if (mode === 'startup-run-fulfilled') {
			expect(child.output()).toContain('JOB_WORKER_STOPPED');
		} else {
			expect(child.messages).toContainEqual({ type: 'fixture-startup-failed', queue: 'deliver' });
			expect(child.output()).toContain('startup.failed');
			expect(child.messages.some((m: any) => m.type === 'fixture-connections')).toBe(false);
			expect(new Set(child.messages.filter((m: any) => m.type === 'fixture-worker-closed').map((m: any) => m.queue))).toEqual(new Set(['endedPollNotification', 'deliver', 'userWebhookDeliver']));
		}
	} finally {
		await child.close(); await f.control.quit(); await f.file.close();
	}
});

test.each(['deliver', 'all'])('rejected %s worker cleanup still closes all real workers and resources', async target => {
	const f = await fixture();
	const child = launch('test/fixtures/queue-runtime-failure.mjs', f.file.path, { QUEUE_RUNTIME_FAILURE: 'cleanup-rejected', QUEUE_RUNTIME_QUEUE: target });
	try {
		await child.ready;
		child.child.kill('SIGTERM');
		expect((await bounded(child.exit)).code, child.output()).toBe(1);
		expect(new Set(child.messages.filter((m: any) => m.type === 'fixture-worker-closed').map((m: any) => m.queue))).toEqual(new Set(['endedPollNotification', 'deliver', 'userWebhookDeliver']));
		expect(child.output()).toContain('shutdown.failed');
		expect((await clients(f.control)).some(line => line.includes(f.config.redisForJobQueue.prefix))).toBe(false);
		expect(await source.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()')).toEqual([{ count: 1 }]);
	} finally {
		await child.close(); await f.control.quit(); await f.file.close();
	}
});

test.each([
	['deliver', false], ['userWebhookDeliver', false], ['deliver', true], ['userWebhookDeliver', true],
] as const)('%s completed-job follow-up holds real dependencies through shutdown (deadline=%s)', async (queueName, deadline) => {
	const f = await fixture(deadline ? 500 : 10000);
	const queue = new Queue(queueName, baseQueueOptions(f.config.redisForJobQueue, queueName, 5000));
	const lock = source.createQueryRunner();
	const id = codec.newId(Date.now());
	const host = toPuny(new URL(inbox.origin).host);
	const table = queueName === 'deliver' ? 'instance' : 'webhook';
	let locked = false;
	let child: ReturnType<typeof launch> | undefined;
	try {
		if (queueName === 'deliver') {
			await source.getRepository(MiInstance).insert({ id, host, firstRetrievedAt: new Date(), isNotResponding: true, notRespondingSince: new Date() });
		} else {
			inbox.respond('/hook', 204);
			await source.getRepository(MiWebhook).insert({ id, userId, name: 'draining hook', active: true, on: ['note'], url: `${inbox.origin}/hook`, secret: 'captured' });
		}
		await lock.connect();
		await lock.startTransaction();
		locked = true;
		await lock.query(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [id]);
		const [{ pid: lockPid }] = await lock.query('SELECT pg_backend_pid() AS pid');
		child = launch('built/entrypoints/worker.js', f.file.path);
		await child.ready;
		const job = queueName === 'deliver'
			? deliverJobs({ user: { id: userId }, activity: { type: 'Create', id: 'drain-activity' }, inboxes: new Map([[`${inbox.origin}/inbox`, false]]) }, {})[0]
			: userWebhookJob({ id, userId, url: `${inbox.origin}/hook`, secret: 'captured' }, 'note', { note: { id: 'drain-note' } }, Date.now(), randomUUID());
		const original = await queue.add(job.name, job.data, job.opts);
		await vi.waitFor(async () => expect(await original.getState()).toBe('completed'), { timeout: 10000 });
		expect((await queue.getJob(original.id!))!.returnvalue).toBe('Success');
		const blockedWrites = () => source.query('SELECT pid, query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE $2', [lockPid, `UPDATE%${table}%`]);
		await vi.waitFor(async () => expect(await blockedWrites()).toHaveLength(1), { timeout: 5000 });
		const [{ pid: writerPid }] = await blockedWrites();
		const stoppedAt = Date.now();
		child.child.kill('SIGTERM');
		if (deadline) {
			expect((await bounded(child.exit, 5000)).code, child.output()).toBe(1);
			expect(Date.now() - stoppedAt).toBeLessThan(5000);
			expect(child.output()).toContain('shutdown.timeout');
			const row = queueName === 'deliver' ? await source.getRepository(MiInstance).findOneByOrFail({ id }) : await source.getRepository(MiWebhook).findOneByOrFail({ id });
			if ('isNotResponding' in row) {
				expect(row.isNotResponding).toBe(true);
			} else {
				expect(row.latestStatus).toBeNull();
			}
			// A lock-waiting PG backend may notice the dead client only after our lock is released.
			await lock.rollbackTransaction();
			locked = false;
			await vi.waitFor(async () => expect(await source.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [writerPid])).toEqual([]), { timeout: 5000, interval: 20 });
		} else {
			// Acquisition connections disappearing establishes that worker cleanup has begun.
			await vi.waitFor(async () => expect((await clients(f.control)).some(line => line.includes(f.config.redisForJobQueue.prefix) && line.includes('cmd=bzpopmin'))).toBe(false));
			expect(child.child.exitCode).toBeNull();
			expect(await blockedWrites()).toHaveLength(1);
			expect((await clients(f.control)).some(line => line.includes(`name=${f.config.redis.connectionName} `))).toBe(true);
			await lock.commitTransaction();
			locked = false;
			expect((await bounded(child.exit)).code, child.output()).toBe(0);
			if (queueName === 'deliver') {
				expect(await source.getRepository(MiInstance).findOneByOrFail({ id })).toMatchObject({ isNotResponding: false, notRespondingSince: null });
			} else {
				expect(await source.getRepository(MiWebhook).findOneByOrFail({ id })).toMatchObject({ latestStatus: 204, latestSentAt: expect.any(Date) });
			}
			expect(child.output()).not.toMatch(/instance-update-failed|status-update-failed/);
		}
	} finally {
		await child?.close();
		if (locked) {
			await lock.rollbackTransaction();
		}
		await lock.release();
		await queue.obliterate({ force: true }); await queue.close();
		await f.control.quit(); await f.file.close();
		if (queueName === 'deliver') {
			await source.getRepository(MiInstance).delete({ id });
		} else {
			await source.getRepository(MiWebhook).delete({ id });
		}
	}
});
