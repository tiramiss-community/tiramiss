/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { BullMQQueueManager } from '@mokurokujs/bullmq-adapter';
import { afterEach, expect, test, vi } from 'vitest';
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

test('prepares exactly three queues without creating workers', async () => {
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
	expect(prepared).toEqual(['endedPollNotification', 'deliver', 'userWebhookDeliver']);
	expect(workers).not.toHaveBeenCalled();
	await owner.stop();
});
