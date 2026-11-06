/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { dump } from 'js-yaml';
import { afterAll, expect, test, vi } from 'vitest';
import { loadConfig } from '../../../src/config/load-config.js';
import { baseQueueOptions } from '../../../src/platform/job-queue/connection.js';
import {
	createDeliverQueue, createDeliverProcessor, DELIVER, deliverJobs, deliverWorkerOptions, httpRelatedBackoff, parseDeliverJob, settleDeliverJob,
} from '../../../src/platform/job-queue/deliver.js';
import { createLogger } from '../../../src/platform/logger.js';
import { loadApDeliverCases } from '../../helpers/ap-deliver-cases.js';
import type { RedisConfig, RuntimeConfig } from '../../../src/config/types.js';

interface JobCases {
	inputs: {
		user: { id: string };
		activity: Record<string, unknown>;
		inboxes: [string, boolean][];
		deliver: { id: string; to: string | null; isSharedInbox: boolean; contentNull?: boolean }[];
		configs: { id: string; config: Record<string, number | null> }[];
		redisForJobQueue: { id: string; options: RedisConfig }[];
		backoff: { attemptsMade: number[]; random: number[] };
		retry: { attempts: number[]; errors: { id: string; name?: string; message: string; unrecoverable?: boolean }[]; random: number };
	};
	cases: {
		enqueue: { id: string; deliver: { id: string; calls: unknown[][] }[]; deliverNullActivity: unknown[]; deliverNullTo: unknown[]; deliverMany: [string, unknown][]; deliverManyEmpty: [string, unknown][] }[];
		queues: { id: string; queueName: string; queueOptions: { connection: Record<string, unknown>; prefix: string } }[];
		workerOptions: { id: string; opts: Record<string, unknown> & { connection: Record<string, unknown> }; backoffStrategy: string }[];
		worker: { name: string; onFailure: { rethrowsOriginal: boolean } };
		workerNames: string[];
		backoff: { random: number; delays: number[] }[];
		retry: { attempts: number; error: string; decisions: { attemptsMade: number; shouldRetry: boolean; delay: number }[] }[];
	};
}

const recorded = loadApDeliverCases<JobCases>('job-cases.json');
const { inputs, cases } = recorded;
const dirs: string[] = [];

afterAll(async () => {
	await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

// 本家の設定ファイルと同じキーを読み込んだ値。null は本家と同じく `??` で既定値になる。
async function configFor(keys: Record<string, number | null>): Promise<RuntimeConfig> {
	const dir = await mkdtemp(join(tmpdir(), 'backend-deliver-config-'));
	dirs.push(dir);
	const file = join(dir, 'test.yml');
	await writeFile(file, dump({ url: 'https://local.example', port: 3000, db: { host: 'localhost', port: 5432 }, redis: { host: 'localhost', port: 6379 }, ...keys }));
	return await loadConfig({ configFile: file, env: { DATABASE_DB: 'test', DATABASE_USER: 'tester' } });
}

test.for(inputs.configs.map((input, index) => [input.id, input, cases.enqueue[index]] as const))('enqueues the same jobs as pinned upstream deliverMany: %s', async ([, input, expected]) => {
	const config = await configFor(input.config);
	const batch = { user: inputs.user, activity: inputs.activity, inboxes: new Map(inputs.inboxes) };

	expect([['addBulk', deliverJobs(batch, config.deliverJob)]]).toEqual(expected.deliverMany);
	expect([['addBulk', deliverJobs({ ...batch, inboxes: new Map() }, config.deliverJob)]]).toEqual(expected.deliverManyEmpty);
});

test.for(inputs.redisForJobQueue.map((input, index) => [input.id, input, cases.queues[index]] as const))('builds the upstream deliver queue prefix: %s', ([, input, expected]) => {
	const options = baseQueueOptions(input.options, DELIVER, 1234);

	expect(expected.queueName).toBe(DELIVER);
	expect(options.prefix).toBe(expected.queueOptions.prefix);
	expect(options.connection).not.toHaveProperty('keyPrefix');
});

test.for(inputs.configs.map((input, index) => [input.id, input, cases.workerOptions[index]] as const))('worker options match pinned upstream apart from fail-fast connection settings: %s', async ([, input, expected]) => {
	const config = await configFor(input.config);

	const { connection, settings, ...options } = deliverWorkerOptions(inputs.redisForJobQueue[0].options, 1234, {
		deliverJobConcurrency: config.outboundHttp.deliverJobConcurrency, deliverJobPerSec: config.deliverJob.deliverJobPerSec,
	});

	const { connection: upstreamConnection, settings: upstreamSettings, ...upstream } = expected.opts;
	expect(options).toEqual(upstream);
	expect(JSON.parse(JSON.stringify(settings))).toEqual(upstreamSettings);
	expect(typeof settings.backoffStrategy).toBe(expected.backoffStrategy);
	expect(connection).toMatchObject(upstreamConnection);
});

test('the upstream worker list includes deliver, which the worker process now runs next to endedPollNotification', () => {
	expect(cases.worker.name).toBe(DELIVER);
	expect(cases.workerNames).toEqual(expect.arrayContaining([DELIVER, 'endedPollNotification']));
});

test.for(cases.backoff)('httpRelatedBackoff gives the upstream delays with Math.random = $random', expected => {
	expect(inputs.backoff.attemptsMade.map(n => httpRelatedBackoff(n, () => expected.random))).toEqual(expected.delays);
});

test.for(cases.retry)('BullMQ retries a deliver job like pinned upstream: attempts=$attempts error=$error', async expected => {
	const input = inputs.retry.errors.find(e => e.id === expected.error)!;
	const error = input.unrecoverable ? new UnrecoverableError(input.message) : Object.assign(new Error(input.message), { name: input.name });
	const { settings } = deliverWorkerOptions(inputs.redisForJobQueue[0].options, 1234, {});
	vi.spyOn(Math, 'random').mockReturnValue(inputs.retry.random);

	try {
		const decisions = [];
		for (let attemptsMade = 0; attemptsMade < expected.attempts; attemptsMade++) {
			const job = { attemptsMade, opts: { attempts: expected.attempts, backoff: { type: 'custom' } }, queue: { opts: { settings } } };
			const [shouldRetry, delay] = await (Job.prototype as unknown as { shouldRetryJob(this: unknown, error: Error): Promise<[boolean, number]> }).shouldRetryJob.call(job, error);
			decisions.push({ attemptsMade, shouldRetry, delay });
		}
		expect(decisions).toEqual(expected.decisions);
	} finally {
		vi.restoreAllMocks();
	}
});

const job = { user: { id: 'alice' }, content: '{}', digest: 'SHA-256=x', to: 'https://remote.example/inbox', isSharedInbox: true };

test.each([
	[job, job],
	[{ ...job, user: { id: 'alice', host: null }, extra: 1 }, job],
])('accepts payload %j', (data, expected) => {
	expect(parseDeliverJob(data)).toEqual(expected);
});

test.each([null, 'x', [], {}, { ...job, user: null }, { ...job, user: { id: 1 } }, { ...job, content: {} }, { ...job, digest: null }, { ...job, to: 1 }, { ...job, isSharedInbox: 'true' }])(
	'rejects malformed payload %j', data => {
		expect(() => parseDeliverJob(data)).toThrow(expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }));
	},
);

test('a finished delivery returns the upstream result string to BullMQ', () => {
	expect(settleDeliverJob({ kind: 'done', result: 'Success' })).toBe('Success');
	expect(settleDeliverJob({ kind: 'done', result: 'skip (suspended)' })).toBe('skip (suspended)');
});

test('a stop is an UnrecoverableError with the upstream message, and a retry rethrows the classified error', () => {
	const retry = new Error('500 Internal Server Error');

	expect(() => settleDeliverJob({ kind: 'stop', message: 'remote.example is gone', hostGone: true })).toThrow(new UnrecoverableError('remote.example is gone'));
	expect(() => settleDeliverJob({ kind: 'stop', message: '404 Not Found', hostGone: false })).toThrow(UnrecoverableError);
	expect(() => settleDeliverJob({ kind: 'retry', error: retry })).toThrow(retry);
});

test('a failed attempt is logged with the inbox and the stop reason, and the error is returned to BullMQ', async () => {
	const logs: Record<string, unknown>[] = [];
	const logger = createLogger('test', line => logs.push(JSON.parse(line)));
	const network = Object.assign(new Error('getaddrinfo ENOTFOUND remote.example'), { code: 'ENOTFOUND' });
	const outcomes = [
		{ kind: 'stop', message: '404 Not Found', hostGone: false } as const,
		{ kind: 'retry', error: network } as const,
	];
	const process = createDeliverProcessor(async () => outcomes.shift()!, logger);

	await expect(process({ id: '1', name: 'remote.example', data: job, attemptsMade: 0 })).rejects.toBeInstanceOf(UnrecoverableError);
	await expect(process({ id: '2', name: 'remote.example', data: job, attemptsMade: 3 })).rejects.toBe(network);
	await expect(process({ id: '3', name: 'x', data: {}, attemptsMade: 0 })).rejects.toMatchObject({ code: 'INVALID_JOB_PAYLOAD' });

	expect(logs.filter(line => line.event === 'job.failed')).toEqual([
		expect.objectContaining({ queue: DELIVER, jobId: '1', to: job.to, reason: '404 Not Found', error: { name: 'UnrecoverableError' } }),
		expect.objectContaining({ queue: DELIVER, jobId: '2', attemptsMade: 3, to: job.to, error: { name: 'Error', code: 'ENOTFOUND' } }),
		expect.objectContaining({ queue: DELIVER, jobId: '3', error: expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }) }),
	]);
	expect(logs.some(line => JSON.stringify(line).includes('ENOTFOUND remote.example'))).toBe(false);
	expect(cases.worker.onFailure.rethrowsOriginal).toBe(true);
});

test.for(inputs.configs.map((input, index) => [input.id, input, cases.enqueue[index]] as const))('single deliver uses Queue.add with pinned upstream jobs: %s', async ([, input, expected]) => {
	const config = await configFor(input.config);
	const calls: unknown[][] = [];
	const add = vi.spyOn(Queue.prototype, 'add').mockImplementation(async (...args) => {
		calls.push(['add', ...args]);
		return {} as never;
	});
	const producer = createDeliverQueue({ redis: inputs.redisForJobQueue[0].options, connectTimeoutMs: 5000, logger: createLogger('test', () => {}), onLost: () => {}, ...config.deliverJob });
	try {
		for (const [index, c] of inputs.deliver.entries()) {
			calls.length = 0;
			await producer.deliverOne({ user: { ...inputs.user, extra: true } as { id: string }, activity: c.contentNull ? null : inputs.activity, to: c.to, isSharedInbox: c.isSharedInbox });
			expect(calls).toEqual(expected.deliver[index].calls);
		}
	} finally {
		add.mockRestore();
		await producer.close();
	}
});
