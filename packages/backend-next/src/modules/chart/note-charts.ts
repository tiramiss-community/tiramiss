/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type ChartSeries = 'notes' | 'perUserNotes' | 'users';
export type ChartSpan = 'hour' | 'day';
export type ChartValues = Record<string, number>;
export interface ChartRow { date: number; values: ChartValues }
export interface ChartNote {
	userId: string; userHost: string | null; visibility: string;
	replyId: string | null; renoteId: string | null; fileIds: readonly string[];
}
export interface NoteChartStore {
	save(input: { series: ChartSeries; group: string | null; diff: ChartValues; now: number; absolute?: ChartValues }): Promise<void>;
	read(series: ChartSeries, group: string | null, span: ChartSpan, from: number, to: number): Promise<ChartRow[]>;
}

export const noteMetrics = ['total', 'inc', 'dec', 'diffs.normal', 'diffs.reply', 'diffs.renote', 'diffs.withFile'] as const;
export function chartKeys(series: ChartSeries): string[] {
	return series === 'users' ? ['local', 'remote'].flatMap(prefix => ['total', 'inc', 'dec'].map(key => `${prefix}.${key}`)) : series === 'notes' ? ['local', 'remote'].flatMap(prefix => noteMetrics.map(key => `${prefix}.${key}`)) : [...noteMetrics];
}

export function interpolateChart(series: ChartSeries, rows: ChartRow[], span: ChartSpan, amount: number, endMs: number): Record<string, number[]> {
	const step = span === 'hour' ? 3600 : 86400;
	const end = Math.floor(endMs / 1000 / step) * step;
	const sorted = [...rows].sort((a, b) => b.date - a.date);
	const result = Object.fromEntries(chartKeys(series).map(key => [key, [] as number[]]));
	for (let i = 0; i < amount; i++) {
		const date = end - i * step;
		const row = sorted.find(log => log.date <= date);
		for (const key of chartKeys(series)) {
			result[key].push(row && (row.date === date || key.endsWith('total')) ? row.values[key] ?? 0 : 0);
		}
	}
	return result;
}

export function createNoteCharts(store: NoteChartStore, clock: () => number) {
	const buffer = new Map<string, { series: ChartSeries; group: string | null; diff: ChartValues }>();
	const append = (series: ChartSeries, group: string | null, diff: ChartValues) => {
		const key = `${series}:${group ?? ''}`;
		const entry = buffer.get(key) ?? { series, group, diff: {} };
		for (const [metric, value] of Object.entries(diff)) {
			entry.diff[metric] = (entry.diff[metric] ?? 0) + value;
		}
		buffer.set(key, entry);
	};
	const metrics = (note: ChartNote, additional: boolean) => {
		const sign = additional ? 1 : -1;
		return {
			total: sign, inc: additional ? 1 : 0, dec: additional ? 0 : 1,
			'diffs.normal': note.replyId === null && note.renoteId === null ? sign : 0,
			'diffs.reply': note.replyId !== null ? sign : 0,
			'diffs.renote': note.renoteId !== null ? sign : 0,
			'diffs.withFile': note.fileIds.length > 0 ? sign : 0,
		};
	};
	const updateUser = (note: ChartNote, additional: boolean) => {
		// The pinned deletion path does not have the creation path's specified guard.
		if (!additional || note.visibility !== 'specified') {
			append('perUserNotes', note.userId, metrics(note, additional));
		}
	};
	return {
		updateUser,
		update(note: ChartNote, additional: boolean, enableChartsForRemoteUser: boolean, authorHost = note.userHost): void {
			const prefix = note.userHost === null ? 'local' : 'remote';
			append('notes', null, Object.fromEntries(Object.entries(metrics(note, additional)).map(([key, value]) => [`${prefix}.${key}`, value])));
			if (authorHost === null || enableChartsForRemoteUser) {
				updateUser(note, additional);
			}
		},
		async flush(): Promise<void> {
			const errors: unknown[] = [];
			// The source saves notes before per-user notes, detaching each series when its turn starts.
			for (const series of ['notes', 'perUserNotes'] as const) {
				const current = [...buffer.entries()].filter(([, entry]) => entry.series === series);
				for (const [key] of current) {
					buffer.delete(key);
				}
				const now = clock();
				const results = await Promise.allSettled(current.map(([, entry]) => store.save({ ...entry, now })));
				errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
			}
			if (errors.length > 0) {
				throw new AggregateError(errors, 'Note chart flush failed');
			}
		},
		async read(series: ChartSeries, span: ChartSpan, amount: number, offset: number | null, group: string | null): Promise<Record<string, unknown>> {
			const step = (span === 'hour' ? 3600 : 86400) * 1000;
			const endMs = offset ? offset + step - 1 : clock();
			const startBase = Math.floor((offset ? offset + step : endMs) / step) * step;
			// Pinned dateUTC rejects the Unix epoch when projecting a cursor onto a period.
			if (endMs === 0 || startBase === 0 || Math.floor(endMs / step) * step === 0) {
				throw new Error('wrong number of arguments');
			}
			const from = startBase / 1000 - (amount - 1) * step / 1000;
			const rows = await store.read(series, group, span, from, Math.floor(endMs / 1000));
			const flat = interpolateChart(series, rows, span, amount, endMs);
			const output: Record<string, unknown> = {};
			for (const [key, values] of Object.entries(flat)) {
				const parts = key.split('.');
				let parent = output;
				for (const part of parts.slice(0, -1)) {
					parent[part] ??= {};
					parent = parent[part] as Record<string, unknown>;
				}
				parent[parts.at(-1)!] = values;
			}
			return output;
		},
	};
}
