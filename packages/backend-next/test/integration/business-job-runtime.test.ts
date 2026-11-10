/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { expect, test, vi } from 'vitest';
import { createBusinessJobDefinitions, createBusinessJobProducers } from '../../src/platform/job-queue/business-jobs.js';
import { createBusinessJobRuntime } from '../../src/platform/job-queue/runtime.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { testConfig } from '../helpers/database.js';
import type { BullmqManagerError } from '@mokurokujs/bullmq-adapter';

function fixture() {
	const prefix = `business-runtime-${randomUUID()}`;
	const config = { redis: { ...testConfig().redisForJobQueue, prefix, connectionName: prefix }, connectTimeoutMs: 5000, deliverJobMaxAttempts: 3 };
	const definitions = createBusinessJobDefinitions(config);
	const control = new Redis({ host: config.redis.host, port: config.redis.port, db: config.redis.db });
	const events: BullmqManagerError[] = [];
	const producer = createBusinessJobRuntime({ ...config, onError: event => events.push(event) });
	const worker = createBusinessJobRuntime({ ...config, onError: event => events.push(event) });
	const jobs = createBusinessJobProducers(producer, definitions, config);
	const queues = ['endedPollNotification', 'deliver', 'userWebhookDeliver'].map(name => new Queue(name, baseQueueOptions(config.redis, name, 5000)));
	return {
		definitions, producer, worker, jobs, queues, events, control, connectionName: prefix,
		async close() {
			await worker.stop();
			await producer.stop();
			for (const queue of queues) {
				await queue.obliterate({ force: true });
				await queue.close();
			}
			await control.quit();
		},
	};
}

test('producer-only readiness prepares three queues, creates no workers and releases its clients', async () => {
	const f = fixture();
	try {
		await Promise.all(f.queues.map(queue => queue.waitUntilReady()));
		const namedClients = async () => String(await f.control.client('LIST')).split('\n').filter(line => line.includes(`name=${f.connectionName} `)).length;
		const baseline = await namedClients();
		await f.producer.runtime.ready(f.definitions.queues, { timeout: 5000 });
		expect(await namedClients()).toBe(baseline + 3);
		for (const queue of f.queues) {
			expect(await queue.getWorkers()).toEqual([]);
		}
		await f.producer.stop();
		expect(await namedClients()).toBe(baseline);
		expect(await f.producer.closedWorkerQueues()).toEqual(new Set());
		await expect(f.jobs.schedulePollEnded({ noteId: 'stale', delayMs: 0 })).rejects.toThrow();
		expect(f.events).toEqual([]);
	} finally {
		await f.close();
	}
});

test('published runtime stores dynamic producer names, snapshots, retention and generated distinct IDs', async () => {
	const f = fixture();
	try {
		await f.producer.runtime.ready(f.definitions.queues, { timeout: 5000 });
		await f.jobs.schedulePollEnded({ noteId: 'same-note', delayMs: -1 });
		await f.jobs.schedulePollEnded({ noteId: 'same-note', delayMs: -1 });
		const batch = { user: { id: 'author' }, activity: { type: 'Create', id: 'activity' }, inboxes: new Map([['https://peer.example/inboxes', true]]) };
		await f.jobs.deliverMany(batch);
		const before = Date.now();
		await f.jobs.enqueueWebhook({ id: 'saved-hook', userId: 'author', url: 'https://hook.example', secret: 'captured' }, 'note', { id: 'snapshot' });
		const after = Date.now();
		const polls = await f.queues[0].getJobs(['waiting']);
		expect(polls).toHaveLength(2);
		expect(new Set(polls.map(job => job.id)).size).toBe(2);
		for (const job of polls) {
			expect(job).toMatchObject({ name: 'same-note', data: { noteId: 'same-note' }, opts: { delay: -1, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } } });
			expect([undefined, 0]).toContain(job.opts.attempts);
			expect(job.opts.backoff).toBeUndefined();
		}
		const [delivery] = await f.queues[1].getJobs(['waiting']);
		expect(delivery).toMatchObject({
			name: 'peer.examplees',
			data: { user: { id: 'author' }, content: '{"type":"Create","id":"activity"}', digest: 'SHA-256=mT/DWFrnp13pDBxT9LWy3AbEcNg6mZr4rZpAKwchWWM=', to: 'https://peer.example/inboxes', isSharedInbox: true },
			opts: { attempts: 3, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } },
		});
		const [webhook] = await f.queues[2].getJobs(['waiting']);
		expect(webhook).toMatchObject({ name: 'saved-hook', data: { webhookId: 'saved-hook', userId: 'author', to: 'https://hook.example', secret: 'captured', type: 'note', content: { note: { id: 'snapshot' } } }, opts: { attempts: 4, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } } });
		expect(webhook.data.createdAt).toBeGreaterThanOrEqual(before);
		expect(webhook.data.createdAt).toBeLessThanOrEqual(after);
		expect(webhook.data.eventId).toMatch(/^[0-9a-f-]{36}$/);
		for (const queue of f.queues) {
			expect(await queue.getWorkers()).toEqual([]);
		}
	} finally {
		await f.close();
	}
});

test('queue defaults consume untouched saved names and payloads and persist string and void results', async () => {
	const f = fixture();
	const observed: unknown[] = [];
	try {
		const payloads = [{ noteId: 'legacy-note' }, { user: { id: 'author' }, content: '{}', digest: 'digest', to: 'https://peer.example/inbox', isSharedInbox: true }, { webhookId: 'legacy-hook', userId: 'author', to: 'https://hook.example', secret: 'saved', type: 'followed', content: { user: { id: 'followed-user' } }, createdAt: 123, eventId: 'saved-event' }];
		const originals = await Promise.all(f.queues.map((queue, index) => queue.add(`unregistered-dynamic-${index}`, payloads[index], { jobId: `original-${index}`, priority: 2, attempts: 3, timestamp: 123456789 })));
		f.worker.runtime.handle(f.definitions.pollEnded, async (payload, context) => {
			observed.push({ payload, context });
		}, { defaultForQueue: true });
		f.worker.runtime.handle(f.definitions.deliver, async (payload, context) => {
			observed.push({ payload, context }); return 'legacy delivery result';
		}, { defaultForQueue: true });
		f.worker.runtime.handle(f.definitions.userWebhook, async (payload, context) => {
			observed.push({ payload, context }); return 'Success';
		}, { defaultForQueue: true });
		await f.worker.runtime.start({ timeout: 5000 });
		await vi.waitFor(async () => {
			for (const job of originals) {
				expect(await job.getState()).toBe('completed');
			}
		}, { timeout: 10000 });
		for (const [index, original] of originals.entries()) {
			const stored = await f.queues[index].getJob(original.id!);
			expect(stored).toMatchObject({ id: original.id, name: original.name, data: payloads[index], opts: original.opts, attemptsMade: 1, returnvalue: [null, 'legacy delivery result', 'Success'][index] });
			expect(observed).toContainEqual({ payload: payloads[index], context: expect.objectContaining({ jobId: original.id, jobName: original.name, attempt: 1 }) });
		}
		await f.worker.stop();
		expect(await f.worker.closedWorkerQueues()).toEqual(new Set(['endedPollNotification', 'deliver', 'userWebhookDeliver']));
		// A separately owned producer can continue after the consumer has stopped.
		await f.jobs.schedulePollEnded({ noteId: 'after-worker-stop', delayMs: 0 });
		expect((await f.queues[0].getJobs(['waiting'])).map(job => job.name)).toEqual(['after-worker-stop']);
		expect(f.events).toEqual([]);
	} finally {
		await f.close();
	}
});
