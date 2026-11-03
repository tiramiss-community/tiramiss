/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { baseQueueOptions, baseWorkerOptions } from '../../../src/platform/job-queue/connection.js';
import {
	createPollEndedProcessor, ENDED_POLL_NOTIFICATION, parsePollEndedJob, pollEndedJobOptions,
} from '../../../src/platform/job-queue/ended-poll-notification.js';
import { createNotePostSaveWork } from '../../../src/platform/note-post-save.js';
import { createLogger } from '../../../src/platform/logger.js';
import type { RedisConfig } from '../../../src/config/types.js';

const recorded = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/poll-ended/job-cases.json', import.meta.url), 'utf8')) as {
	inputs: {
		now: string;
		noteId: string;
		polls: { id: string; poll: { expiresAt: string | null } | null }[];
		redisForJobQueue: { id: string; options: RedisConfig }[];
	};
	cases: {
		enqueue: { id: string; calls: [string, unknown, unknown][] }[];
		queues: { id: string; queueName: string; queueOptions: { connection: Record<string, unknown>; prefix: string }; connectionKeyPrefix: null }[];
		worker: { name: string; opts: Record<string, unknown>; events: string[]; onFailure: { rethrowsOriginal: boolean } };
	};
};

test.each(recorded.inputs.polls.map((input, index) => [input.id, input, recorded.cases.enqueue[index]] as const))('enqueues like pinned upstream: %s', async (_id, input, expected) => {
	const calls: unknown[] = [];
	const work = createNotePostSaveWork({
		counts: async () => {},
		schedulePollEnded: async job => {
			const { name, data, opts } = pollEndedJobOptions(job);
			calls.push([name, data, opts]);
		},
		currentTime: () => Date.parse(recorded.inputs.now),
	});
	await work({
		noteId: recorded.inputs.noteId, userId: 'author', repliedNoteId: null, renotedNoteId: null, channelId: null,
		pollExpiresAtMs: input.poll?.expiresAt == null ? null : Date.parse(input.poll.expiresAt),
	});
	expect(calls).toEqual(expected.calls);
});

test.each(recorded.inputs.redisForJobQueue.map((input, index) => [input.id, input, recorded.cases.queues[index]] as const))('builds the upstream queue prefix and connection without keyPrefix: %s', (_id, input, expected) => {
	const options = baseQueueOptions(input.options, ENDED_POLL_NOTIFICATION, 1234);
	expect(expected.queueName).toBe(ENDED_POLL_NOTIFICATION);
	expect(options.prefix).toBe(expected.queueOptions.prefix);
	expect(options.connection).not.toHaveProperty('keyPrefix');
	// 本家の接続設定に、再接続しない設定と起動期限だけを加える。
	const { retryStrategy, ...connection } = options.connection;
	expect(connection).toEqual({ ...expected.queueOptions.connection, connectTimeout: 1234, maxRetriesPerRequest: null });
	expect(retryStrategy?.(1)).toBeNull();
});

test('worker options match pinned upstream apart from fail-fast connection settings', () => {
	const { worker } = recorded.cases;
	const { connection, ...options } = baseWorkerOptions(recorded.inputs.redisForJobQueue[0].options, ENDED_POLL_NOTIFICATION, 1234);
	const { connection: upstreamConnection, autorun, ...upstream } = worker.opts;
	expect(worker.name).toBe(ENDED_POLL_NOTIFICATION);
	// 本家は concurrency・limiter・attempts・backoff を指定しない（concurrency 1、再試行なし）。
	expect(options).toEqual(upstream);
	expect(autorun).toBe(false);
	expect(connection).toMatchObject(upstreamConnection as object);
	expect(worker.onFailure.rethrowsOriginal).toBe(true);
});

test.each([
	[{ noteId: 'note' }, { noteId: 'note' }],
	[{ noteId: 'note', extra: true }, { noteId: 'note' }],
])('accepts payload %j', (data, expected) => {
	expect(parsePollEndedJob(data)).toEqual(expected);
});

test.each([null, undefined, 'note', [], {}, { noteId: '' }, { noteId: 1 }, { noteId: null }])('rejects malformed payload %j', data => {
	expect(() => parsePollEndedJob(data)).toThrow(expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }));
});

test('a failed attempt is logged with job ids and the original error is returned to BullMQ', async () => {
	const logs: Record<string, unknown>[] = [];
	const logger = createLogger('test', line => logs.push(JSON.parse(line)));
	const failure = Object.assign(new Error('handler failed'), { code: 'HANDLER' });
	const handled: unknown[] = [];
	const process = createPollEndedProcessor(async job => {
		handled.push(job);
		throw failure;
	}, logger);

	await expect(process({ id: '7', name: 'note', data: { noteId: 'note' }, attemptsMade: 0 })).rejects.toBe(failure);
	await expect(process({ id: '8', name: 'note', data: { note: 'missing' }, attemptsMade: 0 })).rejects.toMatchObject({ code: 'INVALID_JOB_PAYLOAD' });

	expect(handled).toEqual([{ noteId: 'note' }]);
	expect(logs.filter(line => line.event === 'job.failed')).toEqual([
		expect.objectContaining({ queue: ENDED_POLL_NOTIFICATION, jobId: '7', jobName: 'note', attemptsMade: 0, error: { name: 'Error', code: 'HANDLER' } }),
		expect.objectContaining({ queue: ENDED_POLL_NOTIFICATION, jobId: '8', error: expect.objectContaining({ code: 'INVALID_JOB_PAYLOAD' }) }),
	]);
});
