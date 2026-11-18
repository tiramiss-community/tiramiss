/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Queue } from 'bullmq';
import { MiMeta, MiUser, MiUserKeypair, MiWebhook } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { deliverJobs } from '../../src/platform/job-queue/deliver.js';
import { userWebhookJob } from '../../src/platform/job-queue/user-webhook.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let server: ReturnType<typeof createServer>;
let origin: string;
const requests = new Map<string, number>();
const userId = createIdCodec('aidx').newId(Date.now() - 10000);

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	await source.getRepository(MiUser).insert({ id: userId, username: 'worker-log', usernameLower: 'worker-log' });
	const pair = await generateRsaKeyPair();
	await source.getRepository(MiUserKeypair).insert({ userId, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	server = createServer(async (req, res) => {
		for await (const _chunk of req) { /* Consume the request before replying. */ }
		const path = new URL(req.url!, 'http://localhost').pathname;
		const count = (requests.get(path) ?? 0) + 1;
		requests.set(path, count);
		res.writeHead(path.includes('terminal') ? 400 : count === 1 ? 500 : 204).end();
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
	if (server) {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
	await source?.destroy();
	await database?.close();
});

function logs(child: ReturnType<typeof launch>): Record<string, unknown>[] {
	return child.output().split('\n').flatMap(line => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

test.each([
	['deliver', 'retry'], ['userWebhookDeliver', 'retry'], ['deliver', 'terminal'], ['userWebhookDeliver', 'terminal'],
] as const)('normal %s worker records every %s attempt and preserves the queue result', async (name, mode) => {
	const prefix = `worker-logs-${randomUUID()}`;
	const config = { ...database.config, http: { port: await freePort() }, redisForJobQueue: { ...database.config.redisForJobQueue, prefix } };
	const file = await configuration(config);
	const queue = new Queue(name, baseQueueOptions(config.redisForJobQueue, name, 5000));
	const child = launch('built/entrypoints/worker.js', file.path);
	const path = `/${name}-${mode}`;
	const to = `${origin}${path}?token=private-token#private-fragment`;
	const hookId = `hook-${name}-${mode}`;
	try {
		await child.ready;
		if (name === 'userWebhookDeliver') {
			await source.getRepository(MiWebhook).insert({ id: hookId, userId, name: hookId, active: true, on: ['note'], url: to, secret: 'private-secret' });
		}
		const job = name === 'deliver'
			? deliverJobs({ user: { id: userId }, activity: { type: 'Create', id: 'private-body' }, inboxes: new Map([[to, false]]) }, {})[0]
			: userWebhookJob({ id: hookId, userId, url: to, secret: 'private-secret' }, 'note', { note: { text: 'private-body' } }, Date.now(), randomUUID());
		// Exercise real BullMQ timed retries quickly; production's custom backoff is compared separately.
		const saved = await queue.add(job.name, job.data, { ...job.opts, attempts: 2, backoff: { type: 'fixed', delay: 25 } });
		await vi.waitFor(async () => expect(await saved.getState()).toBe(mode === 'retry' ? 'completed' : 'failed'), { timeout: 10000 });
		await vi.waitFor(() => expect(logs(child).filter(line => line.queue === name && line.event === (mode === 'retry' ? 'job.completed' : 'job.failed'))).toHaveLength(1), { timeout: 5000 });
		const events = logs(child).filter(line => line.queue === name);
		expect(events.map(line => [line.level, line.event, line.attemptsMade])).toEqual(mode === 'retry'
			? [['debug', 'job.active', 1], ['error', 'job.failed', 0], ['debug', 'job.active', 2], ['debug', 'job.completed', 3]]
			: [['debug', 'job.active', 1], ['error', 'job.failed', 0]]);
		for (const event of events) {
			expect(event).toMatchObject({ process: 'worker', pid: child.child.pid, jobId: saved.id, maxAttempts: 2, ageMs: expect.any(Number), to: `${origin}${path}` });
		}
		expect(requests.get(path)).toBe(mode === 'retry' ? 2 : 1);
		const stored = await queue.getJob(saved.id!);
		expect(stored?.attemptsMade).toBe(mode === 'retry' ? 2 : 1);
		if (mode === 'retry') {
			expect(stored?.returnvalue).toBe('Success');
		} else {
			expect(stored?.failedReason).toContain('400');
		}
		expect(child.output()).not.toContain('private-');
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
	} finally {
		await child.close();
		await queue.obliterate({ force: true });
		await queue.close();
		await file.close();
	}
});

test('normal poll worker records the failed attempt without delivery lifecycle events', async () => {
	const prefix = `poll-logs-${randomUUID()}`;
	const config = { ...database.config, http: { port: await freePort() }, redisForJobQueue: { ...database.config.redisForJobQueue, prefix } };
	const file = await configuration(config);
	const queue = new Queue('endedPollNotification', baseQueueOptions(config.redisForJobQueue, 'endedPollNotification', 5000));
	const child = launch('built/entrypoints/worker.js', file.path);
	try {
		await child.ready;
		const saved = await queue.add('malformed-poll', { privateBody: 'private-body' });
		await vi.waitFor(async () => expect(await saved.getState()).toBe('failed'), { timeout: 10000 });
		await vi.waitFor(() => expect(logs(child).filter(line => line.queue === 'endedPollNotification')).toHaveLength(1), { timeout: 5000 });
		const events = logs(child).filter(line => line.queue === 'endedPollNotification');
		expect(events).toEqual([expect.objectContaining({ level: 'error', event: 'job.failed', jobId: saved.id, jobName: 'malformed-poll', attemptsMade: 0, error: expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }) })]);
		expect(child.output()).not.toContain('private-body');
		child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(0);
	} finally {
		await child.close();
		await queue.obliterate({ force: true });
		await queue.close();
		await file.close();
	}
});
