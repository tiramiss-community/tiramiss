/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createNoteCharts } from './note-charts.js';
import type { NoteChartStore, ChartValues, ChartSpan } from './note-charts.js';

export function createUsersCharts(store: NoteChartStore, clock: () => number, readCounts: () => Promise<{ local: number; remote: number }>) {
	const reader = createNoteCharts(store, clock);
	let buffer: ChartValues = {};
	return {
		update(user: { host: string | null }, additional: boolean): void {
			const prefix = user.host === null ? 'local' : 'remote';
			for (const [metric, value] of Object.entries({ total: additional ? 1 : -1, inc: additional ? 1 : 0, dec: additional ? 0 : 1 })) {
				const key = `${prefix}.${metric}`;
				buffer[key] = (buffer[key] ?? 0) + value;
			}
		},
		async flush(): Promise<void> {
			const diff = buffer;
			buffer = {};
			if (Object.keys(diff).length > 0) {
				await store.save({ series: 'users', group: null, diff, now: clock() });
			}
		},
		async resync(): Promise<void> {
			const counts = await readCounts();
			await store.save({ series: 'users', group: null, diff: {}, absolute: { 'local.total': counts.local, 'remote.total': counts.remote }, now: clock() });
		},
		read(span: ChartSpan, amount: number, offset: number | null): Promise<Record<string, unknown>> {
			return reader.read('users', span, amount, offset, null);
		},
	};
}
