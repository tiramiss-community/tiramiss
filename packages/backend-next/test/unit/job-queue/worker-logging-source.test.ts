/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createDeliverProcessor } from '../../../src/platform/job-queue/deliver.js';
import { createUserWebhookJobProcessor } from '../../../src/platform/job-queue/user-webhook.js';
import { createPollEndedProcessor } from '../../../src/platform/job-queue/ended-poll-notification.js';
import { observeDeliveryWorker } from '../../../src/platform/job-queue/worker-logging.js';
import { createLogger } from '../../../src/platform/logger.js';
import type { JobHandlerContext } from '@mokurokujs/core';
import type { Worker } from 'bullmq';

interface SourceLog { level: string; message: string; fields: null | { e: { name: string }; job?: { name: string; info: string } } }
interface Observation { queue: string; registeredEvents: string[]; logs: SourceLog[] }
const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/worker-logging/observations.json', import.meta.url), 'utf8')) as { commit: string; now: number; observations: Observation[] };

afterEach(() => vi.restoreAllMocks());

function projectSource(log: SourceLog, queue: string) {
	const event = log.message.startsWith('completed(') ? 'completed' : log.message.startsWith('failed(') ? 'failed' : log.message.split(' ')[0];
	const info = log.fields?.job?.info ?? log.message;
	const id = /\bid=(\S+)/.exec(info)?.[1];
	const attempts = /attempts=(\d+)\/(\d+)/.exec(info);
	const delivery = queue !== 'endedPollNotification';
	return {
		event: event === 'error' ? 'job.worker-error' : `job.${event}`,
		level: log.level,
		...(id ? { jobId: id } : {}),
		...(attempts ? { attemptsMade: Number(attempts[1]), ...(delivery ? { maxAttempts: Number(attempts[2]), ageMs: Number(/age=(\d+)ms/.exec(info)?.[1]) } : {}) } : {}),
		...(delivery && / to=/.test(log.message) ? { to: log.message.split(' to=')[1] } : {}),
		...(event === 'completed' ? { result: /^completed\((.*?)\)/.exec(log.message)?.[1] } : {}),
		...(log.fields?.e ? { error: { name: log.fields.e.name } } : {}),
	};
}

test.each(source.observations)('compares fixed-source event selection, severity, attempt fields and rethrow: $queue', async row => {
	expect(source.commit).toBe('8e07cf085adf7009583d234a208e30436f020e26');
	vi.spyOn(Date, 'now').mockReturnValue(source.now);
	const logs: Record<string, unknown>[] = [];
	const logger = createLogger('worker', line => logs.push(JSON.parse(line)));
	const worker = new EventEmitter();
	observeDeliveryWorker(row.queue, worker as Worker, logger);
	expect(worker.eventNames()).toEqual(row.registeredEvents);
	const job = { id: '7', name: 'fixture-job', attemptsMade: 2, opts: { attempts: 4 }, timestamp: 98000, data: { to: 'https://remote.test/inbox', noteId: 'note' } };
	worker.emit('active', job);
	worker.emit('completed', job, 'Success');
	const failure = new Error('controlled retry');
	if (row.registeredEvents.includes('error')) {
		worker.emit('error', failure);
	}
	worker.emit('stalled', '7');
	const context: JobHandlerContext = { jobId: '7', jobName: 'fixture-job', attempt: 3, timestamp: new Date(98000), rawJob: job };
	const fail = async () => {
		throw failure; 
	};
	if (row.queue === 'deliver') {
		await expect(createDeliverProcessor(fail, logger)({ user: { id: 'u' }, content: '{}', digest: 'SHA-256=x', to: job.data.to, isSharedInbox: false }, context)).rejects.toBe(failure);
	} else if (row.queue === 'userWebhookDeliver') {
		await expect(createUserWebhookJobProcessor(fail, logger)({ ...job.data, webhookId: 'h', userId: 'u', secret: '', type: 'note', content: { note: {} }, createdAt: 0, eventId: 'event' }, context)).rejects.toBe(failure);
	} else {
		await expect(createPollEndedProcessor(fail, logger)({ noteId: 'note' }, context)).rejects.toBe(failure);
	}
	const fields = ['event', 'level', 'jobId', 'attemptsMade', 'maxAttempts', 'ageMs', 'to', 'result', 'error'];
	expect(logs.map(log => Object.fromEntries(Object.entries(log).filter(([key]) => fields.includes(key))))).toEqual(row.logs.map(log => projectSource(log, row.queue)));
});

test.each([
	[undefined, undefined],
	['not-a-url private-secret', '[INVALID_URL]'],
	['javascript:private-secret', '[INVALID_URL]'],
	['https://user:private-secret@remote.test/inbox?token=private-token#private-fragment', 'https://remote.test/inbox'],
])('logging removes credentials or rejects unusable destinations: %s', async (input, expected) => {
	const { safeJobDestination } = await import('../../../src/platform/job-queue/worker-logging.js');
	expect(safeJobDestination(input)).toBe(expected);
});
