/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { expect, test, vi } from 'vitest';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createDeliverQueue, startDeliverWorker } from '../../src/platform/job-queue/deliver.js';
import { createPollEndedQueue, startPollEndedWorker } from '../../src/platform/job-queue/ended-poll-notification.js';
import { createUserWebhookQueue, startUserWebhookWorker } from '../../src/platform/job-queue/user-webhook.js';
import { openQueueAdministration } from '../../src/platform/job-queue/administration.js';
import { testConfig } from '../helpers/database.js';
import type { Job } from 'bullmq';

const connected = ['deliver', 'endedPollNotification', 'userWebhookDeliver'] as const;
type Connected = typeof connected[number];
const weekMs = 604800000;
const logger = { info() {}, error() {} };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

// Only handler outcomes are controlled: producer options, parsing, Worker and Redis are real.
async function openFixture(name: Connected) {
	const redis = { ...testConfig().redisForJobQueue, prefix: `retention-${randomUUID()}` };
	const failures: Error[] = [];
	const connection = { redis, connectTimeoutMs: 5000, logger };
	const onLost = () => failures.push(new Error('producer connection lost'));
	const reportFailure = (error: Error) => failures.push(error);
	const producer = name === 'deliver' ? createDeliverQueue({ ...connection, onLost })
		: name === 'endedPollNotification' ? createPollEndedQueue({ ...connection, onLost })
			: createUserWebhookQueue({ ...connection, onLost });
	await producer.ready();
	const queue = new Queue(name, baseQueueOptions(redis, name, 5000));
	const fixtureRedis = new Redis({ host: redis.host, port: redis.port, db: redis.db });
	await queue.waitUntilReady();
	let stop: (() => Promise<void>) | undefined;
	return {
		queue, redis, fixtureRedis,
		async enqueue(marker: string) {
			if ('deliverOne' in producer) {
				await producer.deliverOne({ user: { id: 'retention-user' }, activity: { type: 'Create', id: marker }, to: `https://${marker}.example/inbox`, isSharedInbox: false });
			} else if ('schedule' in producer) {
				await producer.schedule({ noteId: marker, delayMs: 0 });
			} else {
				await producer.enqueue({ id: marker, userId: 'retention-user', url: 'https://hook.example', secret: 'test-only' }, 'note', { id: marker });
			}
			const id = await (await queue.getBackend().client).get(queue.toKey('id'));
			return (await queue.getJob(id!))!;
		},
		async start(handle: (marker: string) => Promise<void> = async marker => {
			if (marker.startsWith('fail')) {
				throw new UnrecoverableError('controlled terminal failure');
			}
		}) {
			if (name === 'deliver') {
				stop = await startDeliverWorker({ ...connection, config: { deliverJobConcurrency: 4 }, reportFailure, process: async job => {
					await handle(new URL(job.to).hostname.replace(/\.example$/, ''));
					return { kind: 'done', result: 'controlled success' };
				} });
			} else if (name === 'endedPollNotification') {
				stop = await startPollEndedWorker({ ...connection, reportFailure, handle: job => handle(job.noteId) });
			} else {
				stop = await startUserWebhookWorker({ ...connection, reportFailure, process: async job => {
					await handle(job.webhookId);
					return 'controlled success';
				} });
			}
		},
		async stop() {
			await stop?.();
			stop = undefined;
		},
		async close() {
			await stop?.();
			await producer.close();
			await queue.obliterate({ force: true });
			await queue.close();
			await fixtureRedis.quit();
			expect(failures).toEqual([]);
		},
	};
}

async function counts(queue: Queue, completed: number, failed: number) {
	await vi.waitFor(async () => {
		expect(await queue.getJobCounts('completed', 'failed', 'active', 'wait')).toEqual({ completed, failed, active: 0, wait: 0 });
	}, { timeout: 15000 });
}

// Fixture-only writes keep both BullMQ representations of terminal time consistent.
async function age(fixture: Awaited<ReturnType<typeof openFixture>>, job: Job, state: 'completed' | 'failed', finishedOn: number) {
	const { queue, fixtureRedis: client } = fixture;
	await client.zadd(queue.toKey(state), finishedOn, job.id!);
	await client.hset(queue.toKey(job.id!), { finishedOn });
}

test.each(connected)('%s real producer/Worker retains 30 successes and 100 failures across distinct names', async name => {
	const fixture = await openFixture(name);
	try {
		const completed: Job[] = [];
		const failed: Job[] = [];
		for (let i = 0; i < 132; i++) {
			const job = await fixture.enqueue(`${i < 31 ? 'success' : 'fail'}-${i}`);
			expect(job.opts).toMatchObject({ removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } });
			await job.log(`retention log ${i}`);
			(i < 31 ? completed : failed).push(job);
		}
		expect(new Set([...completed, ...failed].map(job => job.name)).size).toBe(132);
		await fixture.start();
		await counts(fixture.queue, 30, 100);
		for (const [jobs, state, expectedKept] of [[completed, 'completed', 30], [failed, 'failed', 100]] as const) {
			let kept = 0;
			for (const original of jobs) {
				const job = await fixture.queue.getJob(original.id!);
				const logs = await fixture.queue.getJobLogs(original.id!);
				if (job) {
					kept++;
					expect(await job.getState()).toBe(state);
					expect(job.attemptsMade).toBe(1);
					expect(logs.logs).toHaveLength(1);
					if (state === 'failed') {
						expect(job.failedReason).toBe('controlled terminal failure');
						expect(job.stacktrace?.length).toBeGreaterThan(0);
					} else {
						expect(job.returnvalue).toBe(name === 'endedPollNotification' ? null : 'controlled success');
					}
				} else {
					expect(await fixture.fixtureRedis.exists(fixture.queue.toKey(original.id!))).toBe(0);
					expect(logs.logs).toEqual([]);
				}
			}
			expect(kept).toBe(expectedKept);
		}
	} finally {
		await fixture.close();
	}
});

test.each(connected)('%s lazily removes only expired history in the state being finalized', async name => {
	const fixture = await openFixture(name);
	try {
		const oldSuccess = await fixture.enqueue('success-old');
		const recentSuccess = await fixture.enqueue('success-recent');
		const oldFailure = await fixture.enqueue('fail-old');
		const recentFailure = await fixture.enqueue('fail-recent');
		await oldSuccess.log('old completed log');
		await oldFailure.log('old failed log');
		await fixture.start();
		await counts(fixture.queue, 2, 2);
		await fixture.stop();
		const now = Date.now();
		await age(fixture, oldSuccess, 'completed', now - weekMs - 60000);
		await age(fixture, recentSuccess, 'completed', now - weekMs + 60000);
		await age(fixture, oldFailure, 'failed', now - weekMs - 60000);
		await age(fixture, recentFailure, 'failed', now - weekMs + 60000);
		await fixture.start();
		// Restarting and repeated history reads have no terminal transition to trigger cleanup.
		await counts(fixture.queue, 2, 2);
		expect((await fixture.queue.getJobs(['completed', 'failed'])).map(job => job.id).sort()).toEqual([oldSuccess, recentSuccess, oldFailure, recentFailure].map(job => job.id).sort());
		expect((await fixture.queue.getJobLogs(oldSuccess.id!)).logs).toEqual(['old completed log']);
		const successTrigger = await fixture.enqueue('success-trigger');
		await vi.waitFor(async () => expect(await successTrigger.getState()).toBe('completed'));
		expect(await fixture.queue.getJob(oldSuccess.id!)).toBeUndefined();
		expect((await fixture.queue.getJobLogs(oldSuccess.id!)).logs).toEqual([]);
		expect(await oldFailure.getState()).toBe('failed');
		expect(await recentSuccess.getState()).toBe('completed');
		const failureTrigger = await fixture.enqueue('fail-trigger');
		await vi.waitFor(async () => expect(await failureTrigger.getState()).toBe('failed'));
		expect(await fixture.queue.getJob(oldFailure.id!)).toBeUndefined();
		expect((await fixture.queue.getJobLogs(oldFailure.id!)).logs).toEqual([]);
		expect(await recentFailure.getState()).toBe('failed');
		expect(await recentSuccess.getState()).toBe('completed');
		await counts(fixture.queue, 2, 2);
	} finally {
		await fixture.close();
	}
});

test('raw jobs have no Worker retention fallback; later policy jobs trim the shared state set across names', async () => {
	const fixture = await openFixture('endedPollNotification');
	const otherQueue = new Queue('deliver', baseQueueOptions(fixture.redis, 'deliver', 5000));
	const otherPrefix = new Queue('endedPollNotification', baseQueueOptions({ ...fixture.redis, prefix: `${fixture.redis.prefix}-neighbor` }, 'endedPollNotification', 5000));
	try {
		const raw = await fixture.queue.add('legacy-name', { noteId: 'legacy-note' }, { jobId: 'shared-legacy-id' });
		await raw.log('legacy log');
		const neighborQueue = await otherQueue.add('legacy-name', {}, { jobId: raw.id });
		const neighborPrefix = await otherPrefix.add('legacy-name', {}, { jobId: raw.id });
		expect(raw.opts.removeOnComplete).toBeUndefined();
		expect(raw.opts.removeOnFail).toBeUndefined();
		await fixture.start();
		await counts(fixture.queue, 1, 0);
		await fixture.stop();
		await age(fixture, raw, 'completed', Date.now() - weekMs - 60000);
		await fixture.start();
		await fixture.queue.add('another-raw-name', { noteId: 'second-legacy-note' });
		await counts(fixture.queue, 2, 0);
		expect(await raw.getState()).toBe('completed');
		const trigger = await fixture.enqueue('policy-name');
		await vi.waitFor(async () => expect(await trigger.getState()).toBe('completed'));
		expect(await fixture.queue.getJob(raw.id!)).toBeUndefined();
		expect((await fixture.queue.getJobLogs(raw.id!)).logs).toEqual([]);
		expect(await neighborQueue.getState()).toBe('waiting');
		expect(await neighborPrefix.getState()).toBe('waiting');
	} finally {
		await fixture.close();
		for (const queue of [otherQueue, otherPrefix]) {
			await queue.obliterate({ force: true });
			await queue.close();
		}
	}
});

test('automatic retention and terminal clear protect retry, paused, prioritized, delayed and locked active jobs', async () => {
	const fixture = await openFixture('deliver');
	const releaseHeld = deferred();
	const releaseTrigger = deferred();
	const releaseFailure = deferred();
	let retried = false;
	let admin: Awaited<ReturnType<typeof openQueueAdministration>> | undefined;
	try {
		await fixture.start(async marker => {
			if (marker === 'held') {
				await releaseHeld.promise;
			} else if (marker === 'success-trigger') {
				await releaseTrigger.promise;
			} else if (marker === 'fail-trigger') {
				await releaseFailure.promise;
				throw new UnrecoverableError('controlled terminal failure');
			} else if (marker === 'retry' && !retried) {
				retried = true;
				throw new Error('controlled transient failure');
			} else if (marker.startsWith('fail')) {
				throw new UnrecoverableError('controlled terminal failure');
			}
		});
		const expired = await fixture.enqueue('success-expired');
		const failed = await fixture.enqueue('fail-seed');
		await counts(fixture.queue, 1, 1);
		await age(fixture, expired, 'completed', Date.now() - weekMs - 60000);
		await age(fixture, failed, 'failed', Date.now() - weekMs - 60000);
		const retry = await fixture.enqueue('retry');
		await vi.waitFor(async () => expect(await retry.getState()).toBe('delayed'));
		const delayedRetry = await fixture.queue.getJob(retry.id!);
		expect(delayedRetry!.attemptsMade).toBe(1);
		expect(delayedRetry!.delay).toBeGreaterThanOrEqual(60000);
		expect(delayedRetry!.delay).toBeLessThanOrEqual(72000);
		const active = await fixture.enqueue('held');
		await vi.waitFor(async () => expect(await active.getState()).toBe('active'));
		const trigger = await fixture.enqueue('success-trigger');
		await vi.waitFor(async () => expect(await trigger.getState()).toBe('active'));
		const failureTrigger = await fixture.enqueue('fail-trigger');
		await vi.waitFor(async () => expect(await failureTrigger.getState()).toBe('active'));
		await fixture.queue.pause();
		const timestamp = Date.now() - 2 * weekMs;
		const waiting = await fixture.queue.add('old-waiting', { marker: 'waiting' }, { timestamp });
		const priority = await fixture.queue.add('old-priority', { marker: 'priority' }, { priority: 1, timestamp });
		const delayed = await fixture.queue.add('old-delayed', { marker: 'delayed' }, { delay: 3 * weekMs, timestamp });
		await waiting.log('unfinished log');
		releaseTrigger.resolve();
		await vi.waitFor(async () => expect(await trigger.getState()).toBe('completed'));
		expect(await fixture.queue.getJob(expired.id!)).toBeUndefined();
		expect(await failed.getState()).toBe('failed');
		const assertUnfinished = async () => {
			expect(await active.getState()).toBe('active');
			expect(await fixture.fixtureRedis.exists(fixture.queue.toKey(`${active.id}:lock`))).toBe(1);
			expect(await waiting.getState()).toBe('waiting');
			expect(await fixture.queue.isPaused()).toBe(true);
			expect((await fixture.queue.getWaiting()).map(job => job.id)).toContain(waiting.id);
			expect(await priority.getState()).toBe('prioritized');
			expect(await delayed.getState()).toBe('delayed');
			expect(await retry.getState()).toBe('delayed');
			expect((await fixture.queue.getJobLogs(waiting.id!)).logs).toEqual(['unfinished log']);
		};
		await assertUnfinished();
		releaseFailure.resolve();
		await vi.waitFor(async () => expect(await failureTrigger.getState()).toBe('failed'));
		expect(await fixture.queue.getJob(failed.id!)).toBeUndefined();
		await assertUnfinished();
		admin = await openQueueAdministration({ redis: fixture.redis, connectTimeoutMs: 5000, logger, onLost() {} });
		await admin.clear('deliver', 'completed');
		await admin.clear('deliver', 'failed');
		expect(await fixture.queue.getJob(trigger.id!)).toBeUndefined();
		expect(await fixture.queue.getJob(failureTrigger.id!)).toBeUndefined();
		await assertUnfinished();
		await retry.promote();
		expect(await retry.getState()).toBe('waiting');
		// Remove only the test's deliberately invalid pending payloads before draining the real Worker.
		await waiting.remove();
		await priority.remove();
		await delayed.remove();
		releaseHeld.resolve();
		await fixture.queue.resume();
		await vi.waitFor(async () => expect(await retry.getState()).toBe('completed'));
		expect(await fixture.queue.getJob(retry.id!)).toMatchObject({ attemptsMade: 2, returnvalue: 'controlled success', failedReason: 'controlled transient failure' });
	} finally {
		releaseHeld.resolve();
		releaseTrigger.resolve();
		releaseFailure.resolve();
		await admin?.close();
		await fixture.close();
	}
});
