/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { parseVolumeObservation, volumeAllowsWrites } from '../../src/platform/work-capacity-observation.js';
const now = 1792886400000;
const sample = { volumeId: 'postgres-data', observedAtMs: now, totalBytes: '21474836480', freeBytes: '2147483648' };

test('accepts the exact physical threshold and closes at the 120 second boundary', () => {
	const observation = parseVolumeObservation(sample, 'postgres-data', now);
	expect(volumeAllowsWrites(observation, now)).toBe(true);
	expect(volumeAllowsWrites(observation, now + 119999)).toBe(true);
	expect(volumeAllowsWrites(observation, now + 120000)).toBe(false);
	expect(volumeAllowsWrites(null, now)).toBe(false);
});

test('uses the greater of 2 GiB and ten percent, without rounding down', () => {
	for (const total of ['10737418240', '21474836481', '107374182400']) {
		const value = parseVolumeObservation({ ...sample, totalBytes: total, freeBytes: '2147483647' }, 'postgres-data', now);
		expect(volumeAllowsWrites(value, now)).toBe(false);
	}
});

test.each([
	{ volumeId: 'wrong-volume' }, { observedAtMs: now + 1 }, { observedAtMs: -1 },
	{ freeBytes: '99999999999999999999999' }, { freeBytes: '-1' }, { totalBytes: '0' },
	{ freeBytes: 2147483648 }, { totalBytes: '1e10' }, { freeBytes: '21474836481' },
])('rejects invalid or future observations %j', patch => {
	expect(() => parseVolumeObservation({ ...sample, ...patch }, 'postgres-data', now)).toThrow();
});
