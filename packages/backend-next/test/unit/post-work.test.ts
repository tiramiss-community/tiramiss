/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { preparePostWork, chargedBytes } from '../../src/modules/post-work/prepare.js';
import { apRequest, notificationRequest } from '../helpers/post-work.js';
import { InvalidPostWorkRequest, WorkPayloadTooLarge } from '../../src/modules/post-work/public.js';

test('prepares stable initial identities, exact external bytes and a fixed 24h deadline', () => {
	const request = apRequest();
	const prepared = preparePostWork(request);
	expect(prepared.deadlineAtMs).toBe(request.notBeforeMs + 86400000);
	expect(prepared.items).toEqual([{ kind: 'ap.expand', targetKey: 'all', payload: {} }]);
	expect(JSON.parse(prepared.payloadJson).activity.body).toBe(request.payload.activity.body);
	expect(prepared.hash).toMatch(/^[a-f0-9]{64}$/);
});

test('compares semantic JSON objects independently of caller property order', () => {
	const a = apRequest();
	const b = { ...a, payload: Object.fromEntries(Object.entries(a.payload).reverse()) };
	expect(preparePostWork(b).payloadJson).toBe(preparePostWork(a).payloadJson);
});

test('uses unambiguous notification targets and rejects duplicates', () => {
	const request = notificationRequest();
	const prepared = preparePostWork(request);
	expect(prepared.items.map(item => JSON.parse(item.targetKey))).toEqual([['recipient', 'mention']]);
	expect(() => preparePostWork({ ...request, payload: { candidates: [...request.payload.candidates, ...request.payload.candidates] } })).toThrow(InvalidPostWorkRequest);
});

test.each([
	{ kind: 'unknown' }, { schemaVersion: 2 }, { noteGeneration: 2 },
	{ occurredAtMs: NaN }, { notBeforeMs: Infinity }, { noteId: '' },
	{ actorId: 'a'.repeat(129) }, { eventId: 'x\u0000' }, { payload: { secret: 'no' } },
])('rejects invalid or unimplemented input: %j', patch => {
	expect(() => preparePostWork({ ...apRequest(), ...patch })).toThrow(InvalidPostWorkRequest);
});

test('validates activity identity/type, recipient IDs and channel federation constraints', () => {
	const request = apRequest();
	expect(() => preparePostWork({ ...request, payload: { ...request.payload, activity: { ...request.payload.activity, body: '{}' } } })).toThrow(InvalidPostWorkRequest);
	expect(() => preparePostWork({ ...request, note: { ...request.note, channelId: 'channel', localOnly: false } })).toThrow(InvalidPostWorkRequest);
	expect(() => preparePostWork({ ...notificationRequest(), payload: { candidates: [{ recipientId: '', type: 'mention' }] } })).toThrow(InvalidPostWorkRequest);
});

test('checks UTF-8 bytes and the whole 2 MiB payload before logical capacity', () => {
	const request = apRequest();
	const body = JSON.stringify({ id: request.payload.activity.id, type: 'Create', content: 'あ'.repeat(710000) });
	expect(() => preparePostWork({ ...request, payload: { ...request.payload, activity: { ...request.payload.activity, body } } })).toThrow(WorkPayloadTooLarge);
	expect(chargedBytes(1024, 'あ')).toBe(5120);
	expect(chargedBytes(1024, 'a'.repeat(256))).toBe(5120);
});

test('accepts delete/undo generation 2 and refuses creation notifications after cancellation', () => {
	const request = apRequest();
	const activity = { id: 'https://example.test/activities/delete', type: 'Delete' as const, body: JSON.stringify({ id: 'https://example.test/activities/delete', type: 'Delete' }) };
	expect(preparePostWork({ ...request, noteGeneration: 2, payload: { ...request.payload, activity } }).deleting).toBe(true);
	expect(() => preparePostWork({ ...notificationRequest(), noteGeneration: 2 })).toThrow(InvalidPostWorkRequest);
});

test('counts the full request envelope at the 2 MiB boundary', () => {
	const request = apRequest();
	const empty = JSON.stringify({ id: request.payload.activity.id, type: 'Create', content: '' });
	const candidate = { ...request, payload: { ...request.payload, activity: { ...request.payload.activity, body: empty } } };
	const size = 2 * 1024 * 1024;
	const content = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(candidate)));
	const exact = { ...candidate, payload: { ...candidate.payload, activity: { ...candidate.payload.activity, body: JSON.stringify({ id: request.payload.activity.id, type: 'Create', content }) } } };
	expect(Buffer.byteLength(JSON.stringify(exact))).toBe(size);
	expect(() => preparePostWork(exact)).not.toThrow();
	const over = { ...exact, requestId: `${exact.requestId}x` };
	expect(() => preparePostWork(over)).toThrow(WorkPayloadTooLarge);
});
