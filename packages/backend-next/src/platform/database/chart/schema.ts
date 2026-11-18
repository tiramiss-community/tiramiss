/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EntitySchema } from 'typeorm';
import { chartKeys } from '../../../modules/chart/public.js';
import type { EntitySchemaColumnOptions } from 'typeorm';
import type { ChartSeries, ChartSpan } from '../../../modules/chart/public.js';

export interface NoteChartRecord { id: number; date: number; group?: string; [key: string]: number | string | undefined }
export function createNoteChartSchema(series: ChartSeries, span: ChartSpan): EntitySchema<NoteChartRecord> {
	const columns: Record<string, EntitySchemaColumnOptions> = {
		id: { type: 'integer', primary: true, generated: true }, date: { type: 'integer' },
		...(series === 'perUserNotes' ? { group: { type: 'varchar' as const, length: 128 } } : {}),
	};
	for (const key of chartKeys(series)) {
		columns['___' + key.replaceAll('.', '_')] = { type: (series === 'perUserNotes' || series === 'users') && !key.endsWith('total') ? 'smallint' : 'integer', default: 0 };
	}
	const indexed = series === 'perUserNotes' ? ['date', 'group'] : ['date'];
	return new EntitySchema<NoteChartRecord>({
		name: `${span === 'hour' ? 'ChartX' : 'ChartDayX'}${series}`,
		tableName: `${span === 'hour' ? '__chart__' : '__chart_day__'}${series.replace(/[A-Z]/g, char => '_' + char.toLowerCase())}`,
		columns, indices: [{ columns: indexed, unique: true }], uniques: [{ columns: indexed }],
	});
}
export const noteChartSchemas = {
	users: { hour: createNoteChartSchema('users', 'hour'), day: createNoteChartSchema('users', 'day') },
	notes: { hour: createNoteChartSchema('notes', 'hour'), day: createNoteChartSchema('notes', 'day') },
	perUserNotes: { hour: createNoteChartSchema('perUserNotes', 'hour'), day: createNoteChartSchema('perUserNotes', 'day') },
};
export const noteChartEntities = Object.values(noteChartSchemas).flatMap(spans => Object.values(spans));
