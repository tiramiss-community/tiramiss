/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { preparePostWork, workHash } from '../../src/modules/post-work/prepare.js';
import { LocalWorkValidationCache } from '../../src/platform/database/post-work/local-work-validation.js';
import { apRequest, notificationRequest } from '../helpers/post-work.js';
import type { PostWorkRequest } from '../../src/modules/post-work/public.js';

function saved(suffix = '', input: PostWorkRequest = notificationRequest(suffix)) {
	if (input.kind === 'notification.create') {
		input.payload.candidates = [{ recipientId: 'first', type: 'mention' }, { recipientId: 'second', type: 'reply' }];
	}
	const prepared = preparePostWork(input);
	const request = {
		request_id: input.requestId, event_id: input.eventId, note_id: input.noteId, actor_id: input.actorId,
		note_generation: input.noteGeneration, kind: input.kind, schema_version: Number(input.schemaVersion),
		note_facts: input.note, payload: prepared.payloadJson, payload_hash: prepared.hash,
		occurred_at: new Date(input.occurredAtMs), not_before: new Date(input.notBeforeMs), deadline_at: new Date(prepared.deadlineAtMs),
	};
	const items = prepared.items.map(value => {
		const payload = JSON.stringify(value.payload);
		return {
			kind: value.kind, schema_version: 1, target_key: value.targetKey,
			payload, payload_hash: workHash(payload), deadline_at: request.deadline_at,
		};
	});
	return { request, items };
}

test('sibling items reuse a validated immutable request while retaining their individual payloads', () => {
	const { request, items } = saved();
	const cache = new LocalWorkValidationCache();
	const first = cache.validate(items[0], request);
	const second = cache.validate(items[1], structuredClone(request));
	expect(first).not.toBe(null);
	expect(second?.request).toBe(first?.request);
	expect(second?.payload).toEqual({ recipientId: 'second', type: 'reply' });
	expect(() => {
		if (first?.request.kind === 'notification.create') {
			(first.request.payload.candidates[0] as { recipientId: string }).recipientId = 'changed';
		}
	}).toThrow();
	expect(cache.validate(items[0], request)?.payload).toEqual({ recipientId: 'first', type: 'mention' });
});

test.each(['hash', 'payload', 'deadline', 'metadata'])('cache hits do not hide changed request %s', change => {
	const { request, items } = saved();
	const cache = new LocalWorkValidationCache();
	expect(cache.validate(items[0], request)).not.toBe(null);
	if (change === 'hash') {
		request.payload_hash = '0'.repeat(64);
	} else if (change === 'payload') {
		request.payload = '{}';
	} else if (change === 'deadline') {
		request.deadline_at = new Date(request.deadline_at.getTime() + 1);
	} else {
		request.schema_version = 2;
	}
	expect(cache.validate(items[1], request)).toBe(null);
});

test.each(['hash', 'payload', 'target', 'deadline'])('cached requests still validate each item %s', change => {
	const { request, items } = saved();
	const cache = new LocalWorkValidationCache();
	expect(cache.validate(items[0], request)).not.toBe(null);
	if (change === 'hash') {
		items[1].payload_hash = '0'.repeat(64);
	} else if (change === 'payload') {
		items[1].payload = '{}';
		items[1].payload_hash = workHash('{}');
	} else if (change === 'target') {
		items[1].target_key = 'other';
	} else {
		items[1].deadline_at = new Date(request.deadline_at.getTime() + 1);
	}
	expect(cache.validate(items[1], request)).toBe(null);
});

test('old request entries are evicted instead of retaining unlimited validation results', () => {
	const cache = new LocalWorkValidationCache();
	const first = saved('first');
	const original = cache.validate(first.items[0], first.request);
	for (let i = 0; i < 4; i++) {
		const next = saved(String(i));
		expect(cache.validate(next.items[0], next.request)).not.toBe(null);
	}
	const revalidated = cache.validate(first.items[0], first.request);
	expect(revalidated).not.toBe(null);
	expect(revalidated?.request).not.toBe(original?.request);
});

test('serialized source bytes evict large requests before the four-request count limit', () => {
	const cache = new LocalWorkValidationCache();
	const requests = Array.from({ length: 4 }, (_, i) => {
		const input = apRequest(`large${i}`);
		input.payload.activity.body = JSON.stringify({ id: input.payload.activity.id, type: 'Create', content: 'x'.repeat(1200000) });
		return saved('', input);
	});
	const original = cache.validate(requests[0].items[0], requests[0].request);
	expect(original).not.toBe(null);
	for (const value of requests.slice(1)) {
		expect(cache.validate(value.items[0], value.request)).not.toBe(null);
	}
	const revalidated = cache.validate(requests[0].items[0], requests[0].request);
	expect(revalidated).not.toBe(null);
	expect(revalidated?.request).not.toBe(original?.request);
});
