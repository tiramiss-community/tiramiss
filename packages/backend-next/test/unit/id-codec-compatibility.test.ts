/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import observations from '../../../../docs/superpowers/compatibility/id-codec/observations.json' with { type: 'json' };
import { createIdCodec, type IdMethod } from '../../src/platform/id-codec.js';

afterEach(() => vi.restoreAllMocks());

for (const item of observations.cases) {
	test(`matches fixed upstream generation and existing ID timestamp: ${item.method}/${item.label}`, () => {
		vi.spyOn(Date, 'now').mockReturnValue(item.now);
		const codec = createIdCodec(item.method as IdMethod);
		const atMs = item.label === 'omitted' ? undefined : item.label === 'nan' ? NaN : item.atMs;
		if ('error' in item) {
			expect(() => codec.newId(atMs ?? undefined)).toThrow(expect.objectContaining({ name: item.error!.name }));
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
