/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { classifyHandoffJob } from '../../../src/platform/job-queue/handoff-policy.js';
import type { QueueName } from '../../../src/modules/queue/public.js';

const poll = { name: 'poll', data: JSON.stringify({ noteId: 'note' }), opts: '{}' };

test.each(['wait', 'paused', 'delayed', 'prioritized', 'failed'] as const)('a supported %s job can remain in place', state => {
	expect(classifyHandoffJob('endedPollNotification', state, poll)).toBeNull();
});

test.each(['system', 'postScheduledNote', 'inbox', 'db', 'relationship', 'objectStorage', 'systemWebhookDeliver'] as QueueName[])('%s has no business handler to adopt pending or failed jobs', queue => {
	for (const state of ['wait', 'paused', 'delayed', 'prioritized', 'failed'] as const) {
		expect(classifyHandoffJob(queue, state, poll)).toBe('UNSUPPORTED_QUEUE');
	}
	expect(classifyHandoffJob(queue, 'completed', poll)).toBeNull();
});

test.each([
	{ data: '{}' }, { data: 'null' }, { data: 'secret invalid JSON' },
	{ data: JSON.stringify({ workId: 'old', dispatchSeq: 1, queueGeneration: 1 }) },
])('unknown payload is refused without converting it (%j)', change => {
	expect(classifyHandoffJob('endedPollNotification', 'wait', { ...poll, ...change })).toBe('INVALID_PAYLOAD');
});

test.each([
	['ACTIVE', 'active', {}], ['DEPENDENCY', 'waiting-children', {}], ['DEPENDENCY', 'wait', { parentKey: 'other' }],
	['SCHEDULER', 'wait', { rjk: 'scheduler' }], ['SCHEDULER', 'wait', { opts: '{"repeat":{"every":1000}}' }],
	['UNSUPPORTED_OPTIONS', 'wait', { opts: '{"backoff":{"type":"unimplemented"}}' }],
	['UNSUPPORTED_OPTIONS', 'wait', { opts: '{"attempts":"12"}' }], ['UNSUPPORTED_OPTIONS', 'wait', { opts: '[]' }],
	['UNSUPPORTED_OPTIONS', 'wait', { opts: '{"removeOnFail":"not-a-policy"}' }],
	['UNSUPPORTED_OPTIONS', 'wait', { opts: '{"priority":-1}' }],
])('unresolved %s state is refused', (reason, state, change) => {
	expect(classifyHandoffJob('endedPollNotification', state as 'wait', { ...poll, ...change as object })).toBe(reason);
});

test.each(['note', 'reply', 'renote', 'mention', 'follow', 'unfollow', 'followed'])('webhook %s retains its source transport snapshot', type => {
	const content = ['follow', 'unfollow', 'followed'].includes(type) ? { user: { id: 'old-user' } } : { note: { id: 'old-note' } };
	const raw = { name: 'hook', data: JSON.stringify({ type, content, webhookId: 'hook', userId: 'user', to: 'https://hook.example', secret: '', createdAt: 1, eventId: 'event' }), opts: '{"attempts":4,"backoff":{"type":"custom"}}' };
	expect(classifyHandoffJob('userWebhookDeliver', 'wait', raw)).toBeNull();
	expect(classifyHandoffJob('userWebhookDeliver', 'wait', { ...raw, data: JSON.stringify({ ...JSON.parse(raw.data), type: 'reaction' }) })).toBe('INVALID_PAYLOAD');
});

test.each([{ type: ['note'] }, { type: ['follow'] }, { type: [['followed']] }])('a malformed webhook event discriminator is not coerced to a supported event (%j)', ({ type }) => {
	const data = { type, content: { note: {}, user: {} }, webhookId: 'hook', userId: 'user', to: 'https://hook.example', secret: '', createdAt: 1, eventId: 'event' };
	expect(classifyHandoffJob('userWebhookDeliver', 'wait', { name: 'hook', data: JSON.stringify(data), opts: '{}' })).toBe('INVALID_PAYLOAD');
});

test('malformed progress cannot cross the BullMQ decoder boundary, while valid JSON progress and completed history remain readable', () => {
	expect(classifyHandoffJob('endedPollNotification', 'wait', { ...poll, progress: '{' })).toBe('UNKNOWN_RECORD');
	expect(classifyHandoffJob('endedPollNotification', 'failed', { ...poll, progress: '{' })).toBe('UNKNOWN_RECORD');
	expect(classifyHandoffJob('endedPollNotification', 'wait', { ...poll, progress: '{"processed":1}' })).toBeNull();
	expect(classifyHandoffJob('endedPollNotification', 'completed', { ...poll, progress: '{' })).toBeNull();
});

// Removing the stopped gate must fail before config/Redis can be contacted.
test('the command refuses an unattested live inspection without exposing configuration errors', () => {
	let output = '';
	try {
		execFileSync(process.execPath, ['built/entrypoints/check-queue-handoff.js'], { encoding: 'utf8', env: { ...process.env, MISSKEY_CONFIG_YML: '/sentinel-secret/config.yml' }, stdio: 'pipe' });
	} catch (error) {
		output = String((error as { stderr: string }).stderr);
	}
	expect(output).toContain('STOPPED_ATTESTATION_REQUIRED');
	expect(output).not.toContain('sentinel-secret');
});
