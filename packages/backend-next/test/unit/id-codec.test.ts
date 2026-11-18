/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import observations from '../../../../docs/superpowers/compatibility/id-codec/observations.json' with { type: 'json' };
import { createIdCodec, type IdMethod } from '../../src/platform/id-codec.js';

const time = Date.parse('2026-10-17T12:00:00.123Z');
const cases = [
	['aid', (time - 946684800000).toString(36) + '00', 10],
	['aidx', (time - 946684800000).toString(36) + '00000000', 16],
	['meid', (time + 0x800000000000).toString(16) + '000000000000', 24],
	['meidg', 'g' + time.toString(16) + '000000000000', 24],
	['objectid', Math.floor(time / 1000).toString(16) + '0000000000000000', 24],
	['ulid', '00000000010000000000000000', 26],
] as const;

test.each(cases)('restores %s timestamp and generates compatible distinct IDs', (method, fixture, length) => {
	const codec = createIdCodec(method);
	const expected = method === 'objectid' ? Math.floor(time / 1000) * 1000 : time;
	expect(codec.createdAtFromId(fixture)).toBe(method === 'ulid' ? 1 : expected);
	const ids = Array.from({ length: 100 }, () => codec.newId(time));
	expect(new Set(ids).size).toBe(ids.length);
	for (const id of ids) {
		expect(id).toHaveLength(length);
		expect(id).toMatch(/^[a-zA-Z0-9]+$/);
		expect(codec.createdAtFromId(id)).toBe(expected);
	}
});

afterEach(() => vi.restoreAllMocks());

for (const item of observations.cases) {
	test(`matches fixed upstream generation and existing ID timestamp: ${item.method}/${item.label}`, () => {
		vi.spyOn(Date, 'now').mockReturnValue(item.now);
		const codec = createIdCodec(item.method as IdMethod);
		const atMs = item.label === 'omitted' ? undefined : item.label === 'nan' ? NaN : item.atMs;
		if ('error' in item) {
			expect(() => codec.newId(atMs ?? undefined)).toThrow();
			return;
		}
		const id = codec.newId(atMs ?? undefined);
		const noiseLength = { aid: 2, aidx: 8, meid: 12, meidg: 12, objectid: 16, ulid: 16 }[item.method]!;
		expect({ prefix: id.slice(0, -noiseLength), length: id.length }).toEqual(item.generated);
		expect(codec.createdAtFromId(item.id!)).toBe(item.parsedAt);
	});
}

for (const item of observations.existingIds) {
	test(`restores stored upstream ID with additional boundary: ${item.id}`, () => {
		expect(createIdCodec(item.method as IdMethod).createdAtFromId(item.id)).toBe(item.parsedAt);
	});
}
