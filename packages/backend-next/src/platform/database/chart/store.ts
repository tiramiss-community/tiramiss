/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Between, LessThan } from 'typeorm';
import { chartKeys } from '../../../modules/chart/public.js';
import { noteChartSchemas } from './schema.js';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import type { NoteChartStore, ChartSeries, ChartRow } from '../../../modules/chart/public.js';
import type { NoteChartRecord } from './schema.js';

function convert(series: ChartSeries, row: NoteChartRecord): ChartRow {
	return { date: row.date, values: Object.fromEntries(chartKeys(series).map(key => [key, Number(row['___' + key.replaceAll('.', '_')])])) };
}

export function createNoteChartStore(db: DataSource, redis: Redis, reportUnlockFailure: (error: unknown) => void = () => {}): NoteChartStore {
	const lock = async (name: string) => {
		const key = `lock:chart-insert:${name}`;
		const token = randomUUID();
		for (let retry = 0; retry < 50; retry++) {
			if (await redis.set(key, token, 'PX', 30000, 'NX') === 'OK') {
				return async () => {
					// Compare and delete atomically so an expired owner cannot release a successor's lease.
					await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
				};
			}
			await setTimeout(500);
		}
		throw new Error(`Failed to acquire chart insert lock ${name}`);
	};
	return {
		async save({ series, group, diff, now, absolute }) {
			const claimed = await Promise.allSettled((['hour', 'day'] as const).map(async span => {
				const repository = db.getRepository(noteChartSchemas[series][span]);
				const step = span === 'hour' ? 3600 : 86400;
				const date = Math.floor(now / 1000 / step) * step;
				const where = { date, ...(group === null ? {} : { group }) };
				let row = await repository.findOneBy(where);
				if (row === null) {
					const latest = await repository.findOne({ where: group === null ? {} : { group }, order: { date: 'DESC' } });
					const unlock = await lock(`${series}:${date}:${span}${group === null ? '' : ':' + group}`);
					try {
						row = await repository.findOneBy(where);
						if (row === null) {
							const totals = Object.fromEntries(chartKeys(series).filter(key => key.endsWith('total')).map(key => {
								const column = '___' + key.replaceAll('.', '_');
								return [column, latest?.[column] ?? 0];
							}));
							const inserted = await repository.insert({ ...where, ...totals });
							row = { ...where, ...totals, id: inserted.identifiers[0].id };
						}
					} finally {
						// Lease release must not delay or reject a successfully claimed chart delta.
						void unlock().catch(reportUnlockFailure);
					}
				}
				return { repository, row };
			}));
			const failures = claimed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Note chart claim failed');
			}
			const updates = await Promise.allSettled(claimed.map(async result => {
				if (result.status !== 'fulfilled') {
					return;
				}
				const { repository, row } = result.value;
				const update: Record<string, () => string> = {};
				for (const [key, value] of Object.entries(diff)) {
					if (value !== 0) {
						const column = '___' + key.replaceAll('.', '_');
						const min = (series === 'perUserNotes' || series === 'users') && !key.endsWith('total') ? -32768 : -2147483648;
						const max = (series === 'perUserNotes' || series === 'users') && !key.endsWith('total') ? 32767 : 2147483647;
						// Widen before arithmetic: PostgreSQL integer overflow occurs before LEAST/GREATEST.
						update[column] = () => value > 0
							? `LEAST("${column}"::bigint + ${value}, ${max})`
							: `GREATEST("${column}"::bigint - ${Math.abs(value)}, ${min})`;
					}
				}
				for (const [key, value] of Object.entries(absolute ?? {})) {
					const column = '___' + key.replaceAll('.', '_');
					const clamped = Math.max(-2147483648, Math.min(2147483647, value));
					update[column] = () => String(clamped);
				}
				if (Object.keys(update).length > 0) {
					await repository.createQueryBuilder().update().set(update).where({ id: row.id }).execute();
				}
			}));
			const errors = updates.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
			if (errors.length > 0) {
				throw new AggregateError(errors, 'Note chart update failed');
			}
		},
		async read(series, group, span, from, to) {
			const repository = db.getRepository(noteChartSchemas[series][span]);
			const grouped = group === null ? {} : { group };
			const rows = await repository.find({ where: { ...grouped, date: Between(from, to) }, order: { date: 'DESC' } });
			if (rows.length === 0) {
				const latest = await repository.findOne({ where: grouped, order: { date: 'DESC' } });
				if (latest) {
					rows.push(latest);
				}
			} else if (rows.at(-1)!.date !== from) {
				const previous = await repository.findOne({ where: { ...grouped, date: LessThan(from) }, order: { date: 'DESC' } });
				if (previous) {
					rows.push(previous);
				}
			}
			return rows.map(row => convert(series, row));
		},
	};
}
