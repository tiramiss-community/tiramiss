/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createTimelineCache } from '../../../src/platform/timeline-cache.js';

function setup(options: { now?: number; tail?: string | null; random?: number; fail?: boolean } = {}) {
	const calls: unknown[] = [];
	const redis = {
		pipeline: () => ({
			lpush: (...args: unknown[]) => calls.push(['pipeline-lpush', ...args]),
			ltrim: (...args: unknown[]) => calls.push(['ltrim', ...args]),
			exec: async () => {
				calls.push(['exec']);
				return [[options.fail ? new Error('WRONGTYPE') : null, 1]] as [Error | null, number][];
			},
		}),
		lindex: async (...args: unknown[]) => {
			calls.push(['lindex', ...args]);
			return options.tail ?? null;
		},
		lpush: async (...args: unknown[]) => {
			calls.push(['direct-lpush', ...args]);
			return 1;
		},
	};
	return { calls, cache: createTimelineCache(redis, { createdAtFromId: Number, currentTime: () => options.now ?? 2000000000, random: () => options.random ?? 0.5 }) };
}

test('recent IDs use pipeline, trim only below 10 percent and preserve fractional maxlen', async () => {
	const { calls, cache } = setup({ random: 0.099 });
	const batch = cache.begin('1999900000');
	batch.push({ name: 'homeTimelineWithFiles:user', maxlen: 150.5 });
	await batch.flush();
	expect(calls).toEqual([['pipeline-lpush', 'list:homeTimelineWithFiles:user', '1999900000'], ['ltrim', 'list:homeTimelineWithFiles:user', 0, 149.5], ['exec']]);
});
test('10 percent boundary does not trim', async () => {
	const { calls, cache } = setup({ random: 0.1 });
	const batch = cache.begin('1999900000');
	batch.push({ name: 'localTimeline', maxlen: 1000 });
	await batch.flush();
	expect(calls).toEqual([['pipeline-lpush', 'list:localTimeline', '1999900000'], ['exec']]);
});
test.each([
	['1999820000', null, true], ['1999700000', null, true], ['1999700000', '1999600000', true],
	['1999700000', '1999800000', false], ['1999700000', '1999700000', false],
])('old ID %s with tail %s uses strict time comparison, no trim: %s', async (id, tail, pushed) => {
	const { calls, cache } = setup({ tail, random: 0 });
	const batch = cache.begin(id);
	batch.push({ name: 'localTimeline', maxlen: 1000 });
	await batch.flush();
	expect(calls.filter(x => (x as string[])[0] === 'direct-lpush')).toHaveLength(pushed ? 1 : 0);
	expect(calls).toContainEqual(['lindex', 'list:localTimeline', -1]);
	expect(calls.some(x => ['ltrim', 'pipeline-lpush'].includes((x as string[])[0]))).toBe(false);
});
test('old direct work starts without pipeline execution and drain waits for its completion', async () => {
	let release!: () => void;
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	let done = false;
	const cache = createTimelineCache({ pipeline: () => ({ lpush: () => {}, ltrim: () => {}, exec: async () => [] }), lindex: async () => null, lpush: async () => {
		await wait;
		done = true;
		return 1;
	} }, { createdAtFromId: Number, currentTime: () => 2000000000, random: () => 0 });
	const batch = cache.begin('1999700000');
	batch.push({ name: 'channelTimeline:channel', maxlen: 1000 });
	let drained = false;
	const draining = batch.drain().then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(drained).toBe(false);
	release();
	await draining;
	expect(done).toBe(true);
});
test('Redis command errors are reported after other pipeline commands execute', async () => {
	const { cache, calls } = setup({ fail: true });
	const batch = cache.begin('1999900000');
	batch.push({ name: 'broken', maxlen: 2 });
	batch.push({ name: 'healthy', maxlen: 2 });
	await expect(batch.flush()).rejects.toThrow('Timeline cache update failed');
	expect(calls).toContainEqual(['pipeline-lpush', 'list:healthy', '1999900000']);
});
