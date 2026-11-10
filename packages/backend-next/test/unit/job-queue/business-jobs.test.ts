/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createBusinessJobDefinitions, createBusinessJobProducers } from '../../../src/platform/job-queue/business-jobs.js';
import type { OwnedBusinessJobRuntime } from '../../../src/platform/job-queue/runtime.js';
import type { JobRuntime } from '@mokurokujs/core';

const config = { redis: { host: 'localhost', port: 6379, prefix: 'test' }, connectTimeoutMs: 1234 };

function setup() {
	const enqueue = vi.fn(async () => ({ jobId: '1' }));
	const enqueueBulk = vi.fn(async () => []);
	const assertOpen = vi.fn();
	const owner = { runtime: { enqueue, enqueueBulk }, assertOpen } as unknown as OwnedBusinessJobRuntime;
	const definitions = createBusinessJobDefinitions(config);
	return { enqueue, enqueueBulk, assertOpen, definitions, producers: createBusinessJobProducers(owner, definitions, { deliverJobMaxAttempts: 0 }) };
}

test('preserves dynamic names and producer options', async () => {
	const { producers, enqueue, definitions } = setup();
	await producers.schedulePollEnded({ noteId: 'note', delayMs: -1 });
	expect(enqueue).toHaveBeenLastCalledWith(definitions.pollEnded, { noteId: 'note' }, {
		jobName: 'note', delay: -1, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 },
	});
	await producers.deliverOne({ user: { id: 'author' }, activity: {}, to: 'https://remote.test/inboxes', isSharedInbox: false });
	expect(enqueue).toHaveBeenLastCalledWith(definitions.deliver, expect.objectContaining({ to: 'https://remote.test/inboxes', user: { id: 'author' } }), {
		jobName: 'remote.testes', attempts: 0, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 },
	});
	await producers.enqueueWebhook({ id: 'hook', userId: 'author', url: 'https://hook.test', secret: 'secret' }, 'note', { id: 'note' });
	expect(enqueue).toHaveBeenLastCalledWith(definitions.userWebhook, expect.objectContaining({ webhookId: 'hook', secret: 'secret', type: 'note', content: { note: { id: 'note' } }, createdAt: expect.any(Number), eventId: expect.any(String) }), {
		jobName: 'hook', attempts: 4, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 },
	});
});

test('submits an empty delivery bulk and ignores null single delivery', async () => {
	const { producers, enqueue, enqueueBulk, definitions } = setup();
	await producers.deliverMany({ user: { id: 'author' }, activity: {}, inboxes: new Map() });
	expect(enqueueBulk).toHaveBeenCalledWith(definitions.deliver, []);
	await producers.deliverOne({ user: { id: 'author' }, activity: null, to: 'https://remote.test', isSharedInbox: false });
	await producers.deliverOne({ user: { id: 'author' }, activity: {}, to: null, isSharedInbox: false });
	expect(enqueue).not.toHaveBeenCalled();
});

test('checks ownership before every producer operation', async () => {
	const { producers, assertOpen, enqueue } = setup();
	assertOpen.mockImplementation(() => {
		throw new Error('closed');
	});
	await expect(producers.schedulePollEnded({ noteId: 'note', delayMs: 0 })).rejects.toThrow('closed');
	await expect(producers.deliverMany({ user: { id: 'author' }, activity: {}, inboxes: new Map() })).rejects.toThrow('closed');
	await expect(producers.deliverOne({ user: { id: 'author' }, activity: null, to: null, isSharedInbox: false })).rejects.toThrow('closed');
	await expect(producers.enqueueWebhook({ id: 'h', userId: 'u', url: 'https://h.test', secret: '' }, 'note', {})).rejects.toThrow('closed');
	expect(enqueue).not.toHaveBeenCalled();
});

// Compiled with the package test typecheck; never executes invalid input.
function typeContracts(runtime: JobRuntime) {
	const definitions = createBusinessJobDefinitions(config);
	runtime.handle(definitions.deliver, async () => 'Success');
	runtime.handle(definitions.pollEnded, async () => {});
	// @ts-expect-error delivery handlers must return strings
	runtime.handle(definitions.deliver, async () => 1);
	// @ts-expect-error poll payload must have a noteId
	void runtime.enqueue(definitions.pollEnded, { missing: 'note' });
	void runtime.enqueue(definitions.userWebhook, { webhookId: 'h', userId: 'u', to: 'https://h.test', secret: '', type: 'follow', content: { user: {} }, eventId: 'e', createdAt: 0 });
}

void typeContracts;
