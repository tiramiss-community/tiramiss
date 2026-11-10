/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { startQueueWorkers } from '../../../src/composition/queue-workers.js';
import { testConfig } from '../../helpers/database.js';
import type { BullmqManagerError } from '@mokurokujs/bullmq-adapter';
import type { RuntimeResources } from '../../../src/composition/create-runtime.js';

const state = vi.hoisted(() => ({
	onError: undefined as ((event: BullmqManagerError) => void) | undefined,
	start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
	handle: vi.fn(), deliverIdle: vi.fn(async () => {}), webhookIdle: vi.fn(async () => {}),
	closed: new Set<string>(['deliver', 'userWebhookDeliver', 'endedPollNotification']),
}));
vi.mock('../../../src/platform/job-queue/runtime.js', () => ({ createBusinessJobRuntime: (options: { onError: typeof state.onError }) => {
	state.onError = options.onError;
	return { runtime: { handle: state.handle, start: state.start }, stop: state.stop, closedWorkerQueues: async () => state.closed };
} }));
vi.mock('../../../src/composition/deliver-job.js', () => ({ createDeliverJobHandler: () => ({ process: async () => ({ kind: 'done', result: 'Success' }), idle: state.deliverIdle }) }));
vi.mock('../../../src/composition/poll-ended-job.js', () => ({ createPollEndedHandler: () => async () => {} }));
vi.mock('../../../src/platform/job-queue/user-webhook.js', async original => ({
	...await original<typeof import('../../../src/platform/job-queue/user-webhook.js')>(),
	createUserWebhookProcessor: () => ({ process: async () => 'Success', idle: state.webhookIdle }),
}));
const logger = { error: vi.fn() };
const resources = { logger, outboundHttp: { send: vi.fn() }, dataSource: {} } as unknown as RuntimeResources;

function event(reason: BullmqManagerError['reason']): BullmqManagerError {
	return { queue: 'deliver', resource: 'worker', reason, error: new Error('diagnostic'), connection: 'command' } as BullmqManagerError;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.start.mockImplementation(async () => {});
	state.stop.mockImplementation(async () => {});
	state.closed = new Set(['deliver', 'userWebhookDeliver', 'endedPollNotification']);
});

test('registers three defaults before starting and waits for readiness', async () => {
	let release!: () => void;
	state.start.mockImplementation(async () => {
		await new Promise<void>(resolve => {
			release = resolve;
		});
	});
	let ready = false;
	const pending = startQueueWorkers(resources, testConfig(), () => {}).then(stop => {
		ready = true; return stop;
	});
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
	expect(ready).toBe(false);
	expect(state.handle.mock.calls.map(([definition]) => definition.options.queue.name)).toEqual(['endedPollNotification', 'userWebhookDeliver', 'deliver']);
	for (const call of state.handle.mock.calls) {
		expect(call[2]).toEqual({ defaultForQueue: true });
	}
	release();
	await (await pending)();
});

test.each([
	['connection-ended', 'JOB_QUEUE_REDIS_ENDED'], ['run-fulfilled', 'JOB_WORKER_STOPPED'], ['run-rejected', 'JOB_WORKER_FAILED'],
] as const)('%s propagates after readiness with queue identity', async (reason, code) => {
	const failed = vi.fn();
	const stop = await startQueueWorkers(resources, testConfig(), failed);
	state.onError!(event('error'));
	expect(failed).not.toHaveBeenCalled();
	expect(logger.error).toHaveBeenCalledWith('job-queue.error', expect.objectContaining({ queue: 'deliver' }));
	state.onError!(event(reason));
	expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code, details: expect.objectContaining({ queue: 'deliver' }) }));
	await stop();
	failed.mockClear();
	state.onError!(event(reason));
	expect(failed).not.toHaveBeenCalled();
});

test.each(['connection-ended', 'run-fulfilled', 'run-rejected'] as const)('%s before startup completes rejects startup', async reason => {
	state.start.mockImplementation(async () => {
		state.onError!(event(reason));
	});
	const failed = vi.fn();
	await expect(startQueueWorkers(resources, testConfig(), failed)).rejects.toMatchObject({ code: reason === 'connection-ended' ? 'JOB_QUEUE_REDIS_ENDED' : reason === 'run-fulfilled' ? 'JOB_WORKER_STOPPED' : 'JOB_WORKER_FAILED' });
	expect(state.stop).toHaveBeenCalledOnce();
	expect(failed).not.toHaveBeenCalled();
});

test('startup cause remains primary when library and application cleanup fail', async () => {
	const primary = new Error('startup');
	state.start.mockRejectedValueOnce(new AggregateError([new Error('library cleanup')], 'startup cleanup', { cause: primary }));
	state.stop.mockRejectedValueOnce(new Error('cleanup'));
	await expect(startQueueWorkers(resources, testConfig(), () => {})).rejects.toBe(primary);
	expect(logger.error).toHaveBeenCalledWith('cleanup.failed', { error: expect.any(AggregateError) });
});

test('stop failure drains only successfully closed workers and waits for all eligible drains', async () => {
	const stop = await startQueueWorkers(resources, testConfig(), () => {});
	state.stop.mockRejectedValueOnce(new Error('queue close'));
	state.closed = new Set(['deliver', 'userWebhookDeliver']);
	state.deliverIdle.mockRejectedValueOnce(new Error('deliver idle'));
	let release!: () => void;
	state.webhookIdle.mockImplementationOnce(async () => {
		await new Promise<void>(resolve => {
			release = resolve;
		});
	});
	let settled = false;
	const pending = stop().catch(error => {
		settled = true; return error;
	});
	await vi.waitFor(() => expect(state.webhookIdle).toHaveBeenCalledOnce());
	expect(settled).toBe(false);
	release();
	const result = await pending;
	expect(result).toBeInstanceOf(AggregateError);
	expect(result.errors).toHaveLength(2);
});

test('worker close rejection skips only that worker drain', async () => {
	const stop = await startQueueWorkers(resources, testConfig(), () => {});
	state.closed.delete('deliver');
	state.stop.mockRejectedValueOnce(new Error('worker close'));
	await expect(stop()).rejects.toBeInstanceOf(AggregateError);
	expect(state.deliverIdle).not.toHaveBeenCalled();
	expect(state.webhookIdle).toHaveBeenCalledOnce();
});
