/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { BullMQQueueManager } from '@mokurokujs/bullmq-adapter';
import { afterEach, expect, test, vi } from 'vitest';
import { createLogger } from '../../../src/platform/logger.js';
import { createBusinessJobDefinitions, createBusinessJobProducers } from '../../../src/platform/job-queue/business-jobs.js';
import { createBusinessJobRuntime } from '../../../src/platform/job-queue/runtime.js';
import type { Worker } from 'bullmq';

const config = { redis: { host: 'localhost', port: 6379, prefix: 'test' }, connectTimeoutMs: 1234 };
afterEach(() => vi.restoreAllMocks());

test('rejects producer calls after owned stop begins and caches stop', async () => {
	const close = vi.spyOn(BullMQQueueManager.prototype, 'closeAll').mockResolvedValue();
	const owner = createBusinessJobRuntime({ ...config, onError: () => {} });
	const producers = createBusinessJobProducers(owner, createBusinessJobDefinitions(config), {});
	const stop = owner.stop();
	expect(owner.stop()).toBe(stop);
	await expect(producers.schedulePollEnded({ noteId: 'note', delayMs: 0 })).rejects.toThrow();
	await stop;
	expect(close).toHaveBeenCalledOnce();
});

test('distinguishes fulfilled close with emitted error from rejected close', async () => {
	const failure = new Error('close failed');
	const rejected = Promise.reject(failure);
	void rejected.catch(() => {});
	const workers = [
		{ closing: Promise.resolve() },
		{ closing: rejected },
		{ closing: undefined },
	];
	vi.spyOn(BullMQQueueManager.prototype, 'createWorker').mockImplementation(async () => workers.shift() as Worker);
	vi.spyOn(BullMQQueueManager.prototype, 'getOrCreateQueue').mockReturnValue({} as never);
	vi.spyOn(BullMQQueueManager.prototype, 'waitForReady').mockImplementation(async (_signal, begin) => {
		await begin?.();
	});
	vi.spyOn(BullMQQueueManager.prototype, 'startWorkers').mockResolvedValue();
	vi.spyOn(BullMQQueueManager.prototype, 'closeAll').mockRejectedValue(new AggregateError([failure], 'cleanup diagnostic'));
	const owner = createBusinessJobRuntime({ ...config, onError: () => {} });
	const definitions = createBusinessJobDefinitions(config);
	owner.runtime.handle(definitions.deliver, async () => '', { defaultForQueue: true });
	owner.runtime.handle(definitions.userWebhook, async () => '', { defaultForQueue: true });
	owner.runtime.handle(definitions.pollEnded, async () => {}, { defaultForQueue: true });
	await owner.runtime.start();
	await expect(owner.stop()).rejects.toBeInstanceOf(AggregateError);
	expect(await owner.closedWorkerQueues()).toEqual(new Set(['deliver']));
});

test('prepares exactly four queues without creating workers', async () => {
	const prepared: string[] = [];
	vi.spyOn(BullMQQueueManager.prototype, 'getOrCreateQueue').mockImplementation(definition => {
		prepared.push(definition.name);
		return {} as never;
	});
	vi.spyOn(BullMQQueueManager.prototype, 'waitForReady').mockImplementation(async (_signal, begin) => {
		await begin?.();
	});
	const workers = vi.spyOn(BullMQQueueManager.prototype, 'createWorker');
	const owner = createBusinessJobRuntime({ ...config, onError: () => {} });
	await owner.runtime.ready(createBusinessJobDefinitions(config).queues, { timeout: config.connectTimeoutMs });
	expect(prepared).toEqual(['endedPollNotification', 'deliver', 'userWebhookDeliver', 'system']);
	expect(workers).not.toHaveBeenCalled();
	await owner.stop();
});

test('logs actual delivery worker events with upstream attempt offsets, destination and severity; poll stays silent', async () => {
	const workers = new Map<string, EventEmitter>();
	vi.spyOn(BullMQQueueManager.prototype, 'createWorker').mockImplementation(async definition => {
		const worker = new EventEmitter();
		worker.on('error', () => {});
		workers.set(definition.name, worker);
		return worker as Worker;
	});
	vi.spyOn(BullMQQueueManager.prototype, 'getOrCreateQueue').mockReturnValue({} as never);
	vi.spyOn(BullMQQueueManager.prototype, 'waitForReady').mockImplementation(async (_signal, begin) => {
		await begin?.();
	});
	vi.spyOn(BullMQQueueManager.prototype, 'startWorkers').mockResolvedValue();
	vi.spyOn(BullMQQueueManager.prototype, 'closeAll').mockResolvedValue();
	vi.spyOn(Date, 'now').mockReturnValue(100000);
	const logs: Record<string, unknown>[] = [];
	const owner = createBusinessJobRuntime({ ...config, onError: () => {}, logger: createLogger('worker', line => logs.push(JSON.parse(line))) });
	const definitions = createBusinessJobDefinitions(config);
	owner.runtime.handle(definitions.deliver, async () => '', { defaultForQueue: true });
	owner.runtime.handle(definitions.userWebhook, async () => '', { defaultForQueue: true });
	owner.runtime.handle(definitions.pollEnded, async () => {}, { defaultForQueue: true });
	await owner.runtime.start();
	for (const queue of ['deliver', 'userWebhookDeliver']) {
		const worker = workers.get(queue)!;
		const job = { id: '7', name: 'untrusted-name', attemptsMade: 2, opts: { attempts: 4 }, timestamp: 98000, data: { to: 'https://user:private-pass@remote.test/private-path-secret?token=private-token#private-fragment', secret: 'private-secret', content: 'private-body' } };
		worker.emit('active', job);
		worker.emit('completed', job, 'Success');
		worker.emit('error', new Error('private-error'));
		worker.emit('stalled', '7');
		expect(logs.filter(line => line.queue === queue)).toEqual([
			expect.objectContaining({ level: 'debug', event: 'job.active', jobId: '7', attemptsMade: 3, maxAttempts: 4, ageMs: 2000, to: 'https://remote.test' }),
			expect.objectContaining({ level: 'debug', event: 'job.completed', jobId: '7', attemptsMade: 3, maxAttempts: 4, ageMs: 2000, to: 'https://remote.test', result: 'Success' }),
			expect.objectContaining({ level: 'error', event: 'job.worker-error', error: { name: 'Error' } }),
			expect.objectContaining({ level: 'warn', event: 'job.stalled', jobId: '7' }),
		]);
	}
	const poll = workers.get('endedPollNotification')!;
	expect(poll.listenerCount('active')).toBe(0);
	expect(poll.listenerCount('completed')).toBe(0);
	expect(poll.listenerCount('stalled')).toBe(0);
	expect(logs.some(line => line.queue === 'endedPollNotification')).toBe(false);
	expect(JSON.stringify(logs)).not.toContain('private-');
	await owner.stop();
});
