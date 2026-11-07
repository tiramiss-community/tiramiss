/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { QUEUE_NAMES } from '../../../src/modules/queue/public.js';
import { baseQueueOptions, baseWorkerOptions } from '../../../src/platform/job-queue/connection.js';
import { deliverJobs } from '../../../src/platform/job-queue/deliver.js';
import { pollEndedJobOptions } from '../../../src/platform/job-queue/ended-poll-notification.js';
import { userWebhookJob } from '../../../src/platform/job-queue/user-webhook.js';
import type { JobsOptions } from 'bullmq';
import type { RedisConfig } from '../../../src/config/types.js';

interface Observation { id: string; input: unknown; expected: unknown }
interface Options { connection: Record<string, unknown>; prefix: string; [key: string]: unknown }
interface WorkerObservation { queue: string; options: Options; retentionFallback: unknown }
const corpus = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/queue-retention/observations.json', import.meta.url), 'utf8')) as {
	queueTypes: string[];
	observations: Observation[];
};

function observation<T>(id: string): T {
	const found = corpus.observations.find(item => item.id === id);
	if (!found) {
		throw new Error(`Missing pinned retention observation: ${id}`);
	}
	return found as T;
}

const constructors = observation<{ input: { config: { redisForJobQueue: RedisConfig } }; expected: { queues: { name: string; options: Options }[] } }>('all-queue-constructors');
const workers = observation<{ expected: { workers: WorkerObservation[] } }>('all-worker-options').expected.workers;
const producers = observation<{ expected: { producers: { producer: string; jobs: { opts: JobsOptions }[] }[] } }>('all-queue-service-producer-options').expected.producers;

function producerOptions(name: string): JobsOptions {
	const found = producers.find(item => item.producer === name);
	if (!found) {
		throw new Error(`Missing pinned producer: ${name}`);
	}
	return found.jobs[0].opts;
}

function retention(options: object) {
	return {
		removeOnComplete: 'removeOnComplete' in options ? options.removeOnComplete : undefined,
		removeOnFail: 'removeOnFail' in options ? options.removeOnFail : undefined,
	};
}

// Compare removal policies only: attempts/backoff and payload compatibility have their own source suites.
const batch = {
	user: { id: 'user' }, activity: { type: 'Create' },
	inboxes: new Map([['https://remote.example/inbox', false], ['https://shared.example/inbox', true]]),
};

test.each([undefined, 0, 3])('deliver jobs keep their source retention when maxAttempts is %s', deliverJobMaxAttempts => {
	const jobs = deliverJobs(batch, { deliverJobMaxAttempts });
	const expected = producers.find(item => item.producer === 'deliverMany')!;
	expect(jobs.map(job => retention(job.opts))).toEqual(expected.jobs.map(job => retention(job.opts)));
	expect(retention(jobs[0].opts)).toEqual(retention(producerOptions('deliver')));
});

test.each([5000, -5000])('poll-ended jobs retain the source policy with delay %s', delayMs => {
	const recorded = observation<{ expected: { calls: { args: [string, unknown, JobsOptions] }[] } }>(`poll-ended-delay-${delayMs}`);
	const job = pollEndedJobOptions({ noteId: 'note', delayMs });

	expect(job.opts).toEqual(recorded.expected.calls[0].args[2]);
	// An attempts default would turn the source's one-shot job into a different retry contract.
	expect(job.opts).not.toHaveProperty('attempts');
});

test('user webhook jobs carry their own source retention policy', () => {
	const job = userWebhookJob({ id: 'hook', userId: 'user', url: 'https://hook.example/path', secret: 'secret' }, 'note', { note: { id: 'note' } }, 1800000000000, 'event');

	expect(retention(job.opts)).toEqual(retention(producerOptions('userWebhookDeliver')));
});

test('the source worker and queue observations cover all ten management selectors', () => {
	expect(corpus.queueTypes).toEqual([...QUEUE_NAMES]);
	expect(constructors.expected.queues.map(queue => queue.name).sort()).toEqual([...QUEUE_NAMES].sort());
	expect(workers.map(worker => worker.queue).sort()).toEqual([...QUEUE_NAMES].sort());
});

test.each(constructors.expected.queues)('$name queue options preserve source namespaces without assigning a removal policy', expected => {
	const { connection, ...options } = baseQueueOptions(constructors.input.config.redisForJobQueue, expected.name, 1234);
	const { connectTimeout, maxRetriesPerRequest, retryStrategy, ...sourceConnection } = connection;

	expect({ ...options, connection: sourceConnection }).toEqual(expected.options);
	expect(connectTimeout).toBe(1234);
	expect(maxRetriesPerRequest).toBeNull();
	expect(retryStrategy?.(1)).toBeNull();
});

test('an absent configured prefix preserves the source queue namespace', () => {
	const recorded = observation<{ input: { redisForJobQueue: RedisConfig }; expected: Options }>('prefix-without-configured-prefix');
	const { connection, ...options } = baseQueueOptions(recorded.input.redisForJobQueue, 'deliver', 1234);
	const { connectTimeout: _timeout, maxRetriesPerRequest: _maxRetries, retryStrategy: _retry, ...sourceConnection } = connection;

	expect({ ...options, connection: sourceConnection }).toEqual(recorded.expected);
});

test.each(workers)('$queue worker shares source metrics and has no removal fallback for existing jobs', worker => {
	const { connection, ...options } = baseWorkerOptions(constructors.input.config.redisForJobQueue, worker.queue, 1234);
	const { connectTimeout: _timeout, maxRetriesPerRequest: _maxRetries, retryStrategy: _retry, ...sourceConnection } = connection;
	const { autorun: _autorun, concurrency: _concurrency, limiter: _limiter, settings: _settings, ...sourceBaseOptions } = worker.options;
	const actual = { ...options, connection: sourceConnection };

	expect(actual).toEqual(sourceBaseOptions);
	const fallback = Object.hasOwn(actual, 'removeOnComplete') || Object.hasOwn(actual, 'removeOnFail') ? retention(actual) : null;
	expect(fallback).toEqual(worker.retentionFallback);
});
