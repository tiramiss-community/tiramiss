/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createNoteCharts, interpolateChart } from '../../../src/modules/chart/public.js';
import type { NoteChartStore } from '../../../src/modules/chart/public.js';

const note = { userId: 'alice', userHost: null, visibility: 'public', replyId: null, renoteId: null, fileIds: [] };

function fixture() {
	const save = vi.fn<NoteChartStore['save']>().mockResolvedValue(undefined);
	const read = vi.fn<NoteChartStore['read']>().mockResolvedValue([]);
	return { save, charts: createNoteCharts({ save, read }, () => 1234567890) };
}

test('buffers all notes but skips specified creation for per-user, while deletion still subtracts', async () => {
	const { save, charts } = fixture();
	charts.update({ ...note, visibility: 'specified' }, true, false);
	charts.update({ ...note, visibility: 'specified' }, false, false);
	expect(save).not.toHaveBeenCalled();
	await charts.flush();
	expect(save.mock.calls[0][0]).toMatchObject({ series: 'notes', group: null, diff: { 'local.total': 0, 'local.inc': 1, 'local.dec': 1 } });
	expect(save.mock.calls[1][0]).toMatchObject({ series: 'perUserNotes', group: 'alice', diff: { total: -1, dec: 1 } });
});

test('remote switch only gates per-user, reply and renote can both increase, files count once', async () => {
	const { save, charts } = fixture();
	const remote = { ...note, userHost: 'remote.test', replyId: 'reply', renoteId: 'renote', fileIds: ['one', 'two'] };
	charts.update(remote, true, false);
	charts.update(remote, true, true);
	await charts.flush();
	expect(save.mock.calls[0][0]).toMatchObject({ diff: { 'remote.total': 2, 'remote.diffs.reply': 2, 'remote.diffs.renote': 2, 'remote.diffs.withFile': 2 } });
	expect(save.mock.calls[1][0]).toMatchObject({ diff: { total: 1, 'diffs.normal': 0 } });
});

test('discards attempted buffers on failure, retains arrivals while saving, and tries other series', async () => {
	const { save, charts } = fixture();
	charts.update(note, true, false);
	save.mockImplementationOnce(async () => {
		charts.update(note, true, false);
		throw new Error('db lost');
	});
	await expect(charts.flush()).rejects.toThrow();
	expect(save).toHaveBeenCalledTimes(2);
	save.mockClear();
	await charts.flush();
	expect(save.mock.calls[0][0]).toMatchObject({ diff: { 'local.inc': 1 } });
	save.mockClear();
	await charts.flush();
	expect(save).not.toHaveBeenCalled();
});

test('interpolates only accumulated totals, newest first, without using future rows', () => {
	const rows = [{ date: 0, values: { total: 9, inc: 4 } }, { date: 7200, values: { total: 12, inc: 3 } }];
	expect(interpolateChart('perUserNotes', rows, 'hour', 4, 10800000)).toMatchObject({ total: [12, 12, 9, 9], inc: [0, 3, 0, 4] });
	expect(interpolateChart('perUserNotes', rows, 'hour', 1, -3600000)).toMatchObject({ total: [0], inc: [0] });
});

test('matches literal pinned source producers and cursor interpolation observations', async () => {
	const { readFileSync } = await import('node:fs');
	const observations = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/note-charts/source-observations.json', import.meta.url), 'utf8'));
	for (const input of observations.updates) {
		const { save, charts } = fixture();
		charts.update(input.note, input.additional, true);
		await charts.flush();
		expect(save.mock.calls.find(([call]) => call.series === input.series)![0].diff).toEqual(input.diff);
	}
	for (const input of observations.reads) {
		const store: NoteChartStore = { save: async () => {}, read: async () => input.rows };
		const charts = createNoteCharts(store, () => input.now);
		if (input.expectedError) {
			await expect(charts.read('perUserNotes', input.span, input.limit, input.offset, 'alice')).rejects.toThrow(input.expectedError);
		} else {
			expect(await charts.read('perUserNotes', input.span, input.limit, input.offset, 'alice')).toEqual(input.expected);
		}
	}
});

test('all four production EntitySchema definitions match the inherited fixed manifest', async () => {
	const { readFileSync } = await import('node:fs');
	const { noteChartSchemas } = await import('../../../src/platform/database/chart/schema.js');
	const manifest = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/chart-storage/schema-manifest.json', import.meta.url), 'utf8'));
	for (const series of ['notes', 'perUserNotes'] as const) {
		const chart = manifest.charts.find((entry: { name: string }) => entry.name === series);
		for (const span of ['hour', 'day'] as const) {
			expect({ ...noteChartSchemas[series][span].options, relations: {} }).toEqual(chart.entities[span]);
		}
	}
});

test('notes save starts first and per-user buffers include arrivals before their own save starts', async () => {
	const { save, charts } = fixture();
	charts.update(note, true, false);
	save.mockImplementationOnce(async () => {
		charts.update(note, true, false);
	});
	await charts.flush();
	expect(save.mock.calls[0][0]).toMatchObject({ series: 'notes', diff: { 'local.inc': 1 } });
	expect(save.mock.calls[1][0]).toMatchObject({ series: 'perUserNotes', diff: { inc: 2 } });
	save.mockClear();
	await charts.flush();
	expect(save).toHaveBeenCalledTimes(1);
	expect(save.mock.calls[0][0]).toMatchObject({ series: 'notes', diff: { 'local.inc': 1 } });
});

test('settings failure preserves global and local-author charts; author host is independent from note host', async () => {
	const { createPostingNoteCharts } = await import('../../../src/composition/posting-note-charts.js');
	const { save, charts } = fixture();
	const settings = vi.fn().mockRejectedValue(new Error('cold meta unavailable'));
	const posting = createPostingNoteCharts(charts, settings);
	await posting({ ...note, userHost: 'historic.remote' }, true, null);
	await posting({ ...note, visibility: 'specified' }, true, 'author.remote');
	expect(settings).not.toHaveBeenCalled();
	await expect(posting(note, true, 'author.remote')).rejects.toThrow('cold meta unavailable');
	await charts.flush();
	expect(save.mock.calls[0][0]).toMatchObject({ diff: { 'remote.total': 1, 'local.total': 2 } });
	expect(save.mock.calls[1][0]).toMatchObject({ diff: { total: 1 } });
});
