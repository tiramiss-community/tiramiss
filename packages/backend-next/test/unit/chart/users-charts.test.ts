/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createUsersCharts } from '../../../src/modules/chart/public.js';

test('local and remote additions/deletions buffer six metrics and flush at current clock', async () => {
	const save = vi.fn();
	const read = vi.fn().mockResolvedValue([]);
	let now = 1000;
	const charts = createUsersCharts({ save, read }, () => now, async () => ({ local: 7, remote: 9 }));
	charts.update({ host: null }, true);
	charts.update({ host: 'remote.test' }, true);
	charts.update({ host: 'remote.test' }, false);
	expect(save).not.toHaveBeenCalled();
	now = 2000;
	await charts.flush();
	expect(save).toHaveBeenCalledWith({ series: 'users', group: null, now: 2000, diff: { 'local.total': 1, 'local.inc': 1, 'local.dec': 0, 'remote.total': 0, 'remote.inc': 1, 'remote.dec': 1 } });
	await charts.flush();
	expect(save).toHaveBeenCalledTimes(1);
});

test('resync overwrites current totals from real counts without flushing or replaying the delta buffer', async () => {
	const save = vi.fn();
	const charts = createUsersCharts({ save, read: vi.fn() }, () => 2000, async () => ({ local: 7, remote: 9 }));
	charts.update({ host: null }, true);
	await charts.resync();
	expect(save).toHaveBeenCalledWith({ series: 'users', group: null, now: 2000, diff: {}, absolute: { 'local.total': 7, 'remote.total': 9 } });
	await charts.flush();
	expect(save).toHaveBeenCalledTimes(2);
});

test('failed flush detaches changes, and later commits continue', async () => {
	const save = vi.fn().mockRejectedValueOnce(new Error('db unavailable'));
	const charts = createUsersCharts({ save, read: vi.fn() }, () => 2000, async () => ({ local: 0, remote: 0 }));
	charts.update({ host: null }, false);
	await expect(charts.flush()).rejects.toThrow('db unavailable');
	await charts.flush();
	expect(save).toHaveBeenCalledTimes(1);
	charts.update({ host: 'remote.test' }, true);
	await charts.flush();
	expect(save).toHaveBeenCalledTimes(2);
});

test('matches literal pinned source update, read and resync observations', async () => {
	const { readFileSync } = await import('node:fs');
	const corpus = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/users-charts/source-observations.json', import.meta.url), 'utf8'));
	for (const input of corpus.updates) {
		const save = vi.fn();
		const charts = createUsersCharts({ save, read: vi.fn() }, () => 2000, async () => ({ local: 0, remote: 0 }));
		charts.update({ host: input.host }, input.additional);
		await charts.flush();
		expect(save.mock.calls[0][0].diff).toEqual(input.diff);
	}
	for (const input of corpus.resyncs) {
		const save = vi.fn();
		const charts = createUsersCharts({ save, read: vi.fn() }, () => 2000, async () => ({ local: input.counts[0], remote: input.counts[1] }));
		await charts.resync();
		expect(save.mock.calls[0][0].absolute).toEqual(input.expected);
	}
	for (const input of corpus.reads) {
		const charts = createUsersCharts({ save: vi.fn(), read: async () => input.rows }, () => input.now, async () => ({ local: 0, remote: 0 }));
		if (input.expectedError) {
await expect(charts.read(input.span, input.limit, input.offset)).rejects.toThrow(input.expectedError);
} else {
expect(await charts.read(input.span, input.limit, input.offset)).toEqual(input.expected);
}
	}
});

test('users hour/day definitions match the inherited fixed schema manifest', async () => {
	const { readFileSync } = await import('node:fs');
	const { noteChartSchemas } = await import('../../../src/platform/database/chart/schema.js');
	const manifest = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/chart-storage/schema-manifest.json', import.meta.url), 'utf8'));
	const chart = manifest.charts.find((entry: { name: string }) => entry.name === 'users');
	for (const span of ['hour', 'day'] as const) {
expect({ ...noteChartSchemas.users[span].options, relations: {} }).toEqual(chart.entities[span]);
}
});
