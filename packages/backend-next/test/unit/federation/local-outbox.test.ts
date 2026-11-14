/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import * as federation from '../../../src/modules/federation/public.js';
import type { NotePublicationRow } from '../../../src/modules/federation/public.js';

const note = (id: string) => ({ id, userId: 'alice', userHost: null, localOnly: false, visibility: 'public' } as NotePublicationRow);
const candidate = (id: string, extra = {}) => ({ note: note(id), authorSuspended: false, replyUserId: null, replyUserHost: null, renoteUserId: null, replyAuthorSuspended: false, renoteAuthorSuspended: false, ...extra });

function fixture(ids: string[][], rows = [...new Set(ids.flat())].map(id => candidate(id))) {
	return {
		readTimelineIds: vi.fn(async () => ids),
		readCandidates: vi.fn(async (wanted: string[]) => rows.filter(row => wanted.includes(row.note.id))),
		readDbPage: vi.fn(async () => [note('db')]),
	};
}

const policy = { blockedHosts: [], ugcVisibilityForVisitor: 'all' as const };
// Namespace lookup makes the pre-implementation RED an assertion about the absent public contract.
const read = (...args: Parameters<typeof federation.readOutboxNotes>) => {
	expect(federation.readOutboxNotes).toBeTypeOf('function');
	return federation.readOutboxNotes(...args);
};
test('DB path keeps original empty boundaries and forces limit 20 without cache-only filters', async () => {
	const reader = fixture([]);
	expect(await read('alice', { sinceId: '', untilId: null }, false, policy, reader)).toEqual([note('db')]);
	expect(reader.readDbPage).toHaveBeenCalledExactlyOnceWith('alice', { sinceId: '', untilId: null }, 20);
	expect(reader.readTimelineIds).not.toHaveBeenCalled();
});
test('merges complete lists, deduplicates, bounds, orders and returns twenty rehydrated candidates', async () => {
	const ids = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(3, '0'));
	const reader = fixture([ids, [...ids].reverse()]);
	const result = await read('alice', { sinceId: null, untilId: '030' }, true, policy, reader);
	expect(result.map(row => row.id)).toEqual(ids.slice(9, 29).reverse());
	expect(reader.readDbPage).not.toHaveBeenCalled();
});
test.each([null, ''])('empty and explicit empty since coverage fall back with original cursor %s', async sinceId => {
	const reader = fixture(sinceId === null ? [] : [['010']]);
	await read('alice', { sinceId, untilId: null }, true, policy, reader);
	expect(reader.readDbPage).toHaveBeenCalledExactlyOnceWith('alice', { sinceId, untilId: null }, 20);
	expect(reader.readCandidates).not.toHaveBeenCalled();
});
test('since boundary older than cached coverage uses DB nearest-newer path', async () => {
	const reader = fixture([['030', '020', '010']]);
	await read('alice', { sinceId: '015', untilId: null }, true, policy, reader);
	expect(reader.readDbPage).toHaveBeenCalledExactlyOnceWith('alice', { sinceId: '015', untilId: null }, 20);
});
test('refills after missing/filtered IDs and falls back after last examined rejected candidate', async () => {
	const ids = Array.from({ length: 50 }, (_, i) => String(100 - i).padStart(3, '0'));
	const rows = [candidate('100'), ...ids.slice(1, -1).map(id => candidate(id, { authorSuspended: true }))];
	const reader = fixture([ids], rows);
	const result = await read('alice', { sinceId: null, untilId: null }, true, policy, reader);
	expect(result.map(row => row.id)).toEqual(['100', 'db']);
	expect(reader.readCandidates.mock.calls.length).toBeGreaterThan(1);
	expect(reader.readDbPage).toHaveBeenCalledExactlyOnceWith('alice', { untilId: '051', sinceId: null }, 19);
});
test.each([
	{ authorSuspended: true }, { replyUserId: 'other', replyAuthorSuspended: true },
	{ renoteUserId: 'other', renoteAuthorSuspended: true }, { replyUserId: 'other', replyUserHost: 'sub.blocked.test' },
	{ renoteUserId: 'other', note: { ...note('020'), renoteUserHost: 'blocked.test' } },
	{ note: { ...note('020'), localOnly: true } }, { note: { ...note('020'), visibility: 'followers' } },
	{ note: { ...note('020'), userHost: 'blocked.test' } },
])('cache filters $authorSuspended $replyUserHost then DB fallback remains unfiltered', async extra => {
	const reader = fixture([['020']], [candidate('020', extra)]);
	expect(await read('alice', { sinceId: null, untilId: null }, true, { ...policy, blockedHosts: ['blocked.test'] }, reader)).toEqual([note('db')]);
});
test.each(['none', 'local'] as const)('visitor %s filters cached remote rows', async ugcVisibilityForVisitor => {
	const reader = fixture([['020']], [candidate('020', { note: { ...note('020'), userHost: 'remote.test' } })]);
	expect(await read('alice', { sinceId: null, untilId: null }, true, { ...policy, ugcVisibilityForVisitor }, reader)).toEqual([note('db')]);
});
test('Redis rejection does not become DB fallback', async () => {
	const reader = fixture([]);
	reader.readTimelineIds.mockRejectedValue(new Error('WRONGTYPE'));
	await expect(read('alice', { sinceId: null, untilId: null }, true, policy, reader)).rejects.toThrow('WRONGTYPE');
	expect(reader.readDbPage).not.toHaveBeenCalled();
});
test('collection preserves stored count, fixed-zero last, explicit empty URL and both navigation links', () => {
	expect(federation.renderOutboxCollection).toBeTypeOf('function');
	const base = 'https://local.test/users/alice/outbox';
	expect(federation.renderOutboxCollection('alice', 75, null, 'https://local.test')).toMatchObject({ totalItems: 75, first: `${base}?page=true`, last: `${base}?page=true&since_id=000000000000000000000000` });
	expect(federation.renderOutboxCollection('alice', 75, { bounds: { sinceId: '', untilId: null }, notes: [note('020')], activities: [{ type: 'Create' }] }, 'https://local.test')).toMatchObject({ id: `${base}?page=true&since_id=`, totalItems: 75, partOf: base, prev: `${base}?page=true&since_id=020`, next: `${base}?page=true&until_id=020`, orderedItems: [{ type: 'Create' }] });
});
