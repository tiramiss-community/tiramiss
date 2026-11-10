/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
import { startWorker } from '../../src/processes/worker.js';
import { testConfig } from '../helpers/database.js';
import type { Job } from 'bullmq';

const state = vi.hoisted(() => ({
	workers: [] as { name: string; ready: () => Promise<void>; close: () => Promise<void>; process: (job: Job) => Promise<unknown>; emit: (event: string, ...args: unknown[]) => boolean }[],
	ready: new Map<string, () => Promise<void>>(),
	close: new Map<string, () => Promise<void>>(),
	events: [] as string[],
	logger: { error: vi.fn() },
	update: vi.fn(async () => {}),
	releaseResources: vi.fn(async () => {}),
}));
vi.mock('../../src/composition/create-runtime.js', () => ({ createRuntime: async () => ({
	federationKeys: { readUserKeypair: async () => {
		throw new Error('key unavailable');
	} }, outboundHttp: { send: vi.fn(async () => {
		throw new Error('network unavailable');
	}) },
	redis: { get: async () => null, set: async () => {} },
	dataSource: { manager: { getRepository: (entity: { name: string }) => ({
		find: async () => entity.name === 'MiMeta' ? [{ federation: 'all', federationHosts: [], blockedHosts: [], silencedHosts: [], mediaSilencedHosts: [], deliverSuspendedSoftware: [], enableStatsForFederatedInstances: true }] : [],
		findOneBy: async () => ({ id: 'instance', host: 'remote.test', isNotResponding: false, notRespondingSince: null, suspensionState: 'none', softwareName: null, softwareVersion: null }),
		update: state.update,
		createQueryBuilder: () => {
			const query = { update: () => query, set: () => query, where: () => query, returning: () => query, execute: async () => {
				await state.update();
				return { raw: [] };
			} };
			return query;
		},
	}) } }, logger: state.logger, close: state.releaseResources,
	failure: new Promise(() => {}),
}) }));
vi.mock('../../src/platform/database/check-migrations.js', () => ({ assertMigrationsApplied: async () => {} }));
vi.mock('node-fetch', () => ({ default: async () => {
	throw new Error('network unavailable');
} }));
vi.mock('cacheable-lookup', () => ({ default: class {
	lookup = vi.fn();
} }));
vi.mock('../../src/platform/job-queue/runtime.js', () => ({ createBusinessJobRuntime: (options: { onError(event: unknown): void }) => {
	const closed = new Set<string>();
	const diagnostics: unknown[] = [];
	const registrations: { name: string; handler: (payload: unknown, context: unknown) => Promise<unknown> }[] = [];
	return {
		runtime: {
			handle: (definition: { options: { queue: { name: string } } }, handler: (payload: unknown, context: unknown) => Promise<unknown>) => {
				registrations.push({ name: definition.options.queue.name, handler });
			},
			async start() {
				for (const { name, handler } of registrations) {
					const client = new EventEmitter();
					const worker = {
						name, client, emit: (event: string, ...args: unknown[]) => {
							if (event === 'error') {
								diagnostics.push(args[0]);
								options.onError({ queue: name, resource: 'worker', reason: 'cleanup', error: args[0] });
							}
							return true;
						},
						ready: async () => {
							await state.ready.get(name)?.();
						},
						close: async () => {
							state.events.push(`close:${name}`);
							await state.close.get(name)?.();
							closed.add(name);
						},
						process: async (job: Job) => await handler(job.data, { jobId: job.id, jobName: job.name, attempt: job.attemptsMade + 1, timestamp: new Date() }),
					};
					client.on('end', () => options.onError({ queue: name, resource: 'worker', reason: 'connection-ended', error: new Error('ended') }));
					state.events.push(`construct:${name}`);
					state.workers.push(worker);
				}
				await Promise.all(state.workers.map(worker => worker.ready()));
			},
		},
		async stop() {
			const errors: unknown[] = [];
			const results = await Promise.allSettled(state.workers.map(worker => worker.close()));
			for (const result of results) {
				if (result.status === 'rejected') {
					errors.push(result.reason);
				}
			}
			// Model manager cleanup diagnostics independently from the close result.
			errors.push(...diagnostics);
			for (const { name } of registrations) {
				try {
					await state.close.get(`queue:${name}`)?.();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) {
				throw new AggregateError(errors, 'cleanup');
			}
		},
		closedWorkerQueues: async () => closed,
	};
} }));

beforeEach(() => {
	state.workers.length = 0;
	state.events.length = 0;
	state.ready.clear();
	state.close.clear();
	vi.clearAllMocks();
});

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

test('waits for readiness and every parallel stop before releasing resources', async () => {
	const ready = gate();
	state.ready.set('endedPollNotification', () => ready.promise);
	const pending = startWorker(testConfig());
	await vi.waitFor(() => expect(state.workers).toHaveLength(3));
	ready.resolve();
	const running = await pending;
	expect(state.workers.map(w => w.name)).toEqual(['endedPollNotification', 'userWebhookDeliver', 'deliver']);
	const closing = gate();
	state.close.set('userWebhookDeliver', () => closing.promise);
	let stopped = false;
	const stop = running.stop().then(() => {
		stopped = true;
	});
	await vi.waitFor(() => expect(state.events.filter(e => e.startsWith('close:'))).toHaveLength(3));
	expect(stopped).toBe(false);
	expect(state.releaseResources).not.toHaveBeenCalled();
	closing.resolve();
	await stop;
	expect(state.releaseResources).toHaveBeenCalledOnce();
});

test.each(['userWebhookDeliver', 'deliver'])('retains %s startup error after waiting for cleanup, even when cleanup fails', async name => {
	const failure = new Error('startup');
	const cleanup = new Error('cleanup');
	const closing = gate();
	state.ready.set(name, async () => {
		throw failure;
	});
	state.close.set('endedPollNotification', async () => {
		await closing.promise;
		throw cleanup;
	});
	let settled = false;
	const result = startWorker(testConfig()).catch(error => {
		settled = true;
		return error;
	});
	await vi.waitFor(() => expect(state.events).toContain('close:endedPollNotification'));
	expect(settled).toBe(false);
	expect(state.releaseResources).not.toHaveBeenCalled();
	closing.resolve();
	expect(await result).toBe(failure);
	expect(state.logger.error).toHaveBeenCalledWith('cleanup.failed', { error: expect.any(AggregateError) });
	expect(state.events.filter(e => e.startsWith('close:'))).toHaveLength(3);
	expect(state.releaseResources).toHaveBeenCalledOnce();
});

test('a close rejection still waits for the other workers and reports the aggregate', async () => {
	const running = await startWorker(testConfig());
	const closing = gate();
	const failure = new Error('close');
	state.close.set('userWebhookDeliver', async () => {
		throw failure;
	});
	state.close.set('deliver', () => closing.promise);
	let settled = false;
	const stop = running.stop().catch(error => {
		settled = true;
		return error;
	});
	await vi.waitFor(() => expect(state.events).toContain('close:deliver'));
	expect(settled).toBe(false);
	closing.resolve();
	const error = await stop;
	expect(error).toBeInstanceOf(AggregateError);
	expect(state.releaseResources).toHaveBeenCalledOnce();
});

test('connection loss propagates to the process failure promise', async () => {
	const running = await startWorker(testConfig());
	// The owned-runtime double supplies the network event; composition translates it.
	const worker = state.workers[1] as unknown as { client: EventEmitter };
	Object.assign(worker.client, { status: 'end' });
	worker.client.emit('end');
	await expect(running.failure).resolves.toHaveProperty('code', 'JOB_QUEUE_REDIS_ENDED');
	await running.stop();
});

test.each(['userWebhookDeliver', 'deliver'])('%s drains background work only after a successful close', async name => {
	const running = await startWorker(testConfig());
	const update = gate();
	state.update.mockImplementationOnce(() => update.promise);
	const worker = state.workers.find(value => value.name === name)!;
	const data = name === 'deliver'
		? { user: { id: 'author' }, content: '{}', digest: 'digest', to: 'https://remote.test/inbox', isSharedInbox: false }
		: { webhookId: 'hook', userId: 'author', to: 'https://remote.test/hook', secret: '', type: 'note', content: { note: {} }, createdAt: 0, eventId: 'event' };
	await worker.process({ data, name: 'job', attemptsMade: 0 } as Job).catch(() => {});
	await vi.waitFor(() => expect(state.update).toHaveBeenCalled());
	const close = gate();
	state.close.set(name, () => close.promise);
	let stopped = false;
	const stop = running.stop().then(() => {
		stopped = true;
	});
	await vi.waitFor(() => expect(state.events).toContain(`close:${name}`));
	expect(stopped).toBe(false);
	close.resolve();
	await new Promise(resolve => setImmediate(resolve));
	expect(stopped).toBe(false);
	update.resolve();
	await stop;
});

test.each(['userWebhookDeliver', 'deliver'])('%s close failure does not wait for idle work', async name => {
	const running = await startWorker(testConfig());
	const update = gate();
	state.update.mockImplementationOnce(() => update.promise);
	const worker = state.workers.find(value => value.name === name)!;
	const data = name === 'deliver'
		? { user: { id: 'author' }, content: '{}', digest: 'digest', to: 'https://remote.test/inbox', isSharedInbox: false }
		: { webhookId: 'hook', userId: 'author', to: 'https://remote.test/hook', secret: '', type: 'note', content: { note: {} }, createdAt: 0, eventId: 'event' };
	await worker.process({ data, name: 'job', attemptsMade: 0 } as Job).catch(() => {});
	await vi.waitFor(() => expect(state.update).toHaveBeenCalled());
	state.close.set(name, async () => {
		throw new Error('close failed');
	});
	try {
		await expect(running.stop()).rejects.toBeInstanceOf(AggregateError);
	} finally {
		update.resolve();
	}
});

test.each(['userWebhookDeliver', 'deliver'])('%s drains after emitted cleanup error when close fulfills', async name => {
	const running = await startWorker(testConfig());
	const update = gate();
	state.update.mockImplementationOnce(() => update.promise);
	const worker = state.workers.find(value => value.name === name)!;
	const data = name === 'deliver'
		? { user: { id: 'author' }, content: '{}', digest: 'digest', to: 'https://remote.test/inbox', isSharedInbox: false }
		: { webhookId: 'hook', userId: 'author', to: 'https://remote.test/hook', secret: '', type: 'note', content: { note: {} }, createdAt: 0, eventId: 'event' };
	await worker.process({ data, name: 'job', attemptsMade: 0 } as Job).catch(() => {});
	await vi.waitFor(() => expect(state.update).toHaveBeenCalled());
	state.close.set(name, async () => {
		worker.emit('error', new Error('emitted while closing'));
	});
	let settled = false;
	const stop = running.stop().catch(error => {
		settled = true; return error;
	});
	await vi.waitFor(() => expect(state.events).toContain(`close:${name}`));
	await new Promise(resolve => setImmediate(resolve));
	expect(settled).toBe(false);
	expect(state.releaseResources).not.toHaveBeenCalled();
	update.resolve();
	expect(await stop).toBeInstanceOf(AggregateError);
	expect(state.releaseResources).toHaveBeenCalledOnce();
});
