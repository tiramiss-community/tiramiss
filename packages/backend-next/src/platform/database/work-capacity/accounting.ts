/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from '../../diagnostic-error.js';
import { workCapacity } from '../../../modules/post-work/prepare.js';
import type { DataSource, EntityManager } from 'typeorm';

export const chargedTables = ['work_capacity', 'work_control', 'note_work_state', 'work_request', 'work_item',
	'queue_dispatch', 'delivery_recipient', 'notification', 'notification_effect', 'ap_host_lease'] as const;
export interface CapacityFormula { coefficient: number; formulaVersion: number }
export const currentFormula: CapacityFormula = { coefficient: 4, formulaVersion: workCapacity.formulaVersion };

async function totals(manager: EntityManager, formulaVersion: number, capacityVersion = formulaVersion) {
	let rows = 0n;
	let bytes = 0n;
	for (const table of chargedTables) {
		// Fixed internal identifiers only; SQL aggregates inspect saved charges, not business CRUD.
		const [sum] = await manager.query(`SELECT count(*)::text AS rows, COALESCE(sum(charged_bytes),0)::text AS bytes,
		 count(*) FILTER (WHERE capacity_formula_version<>$1 OR charged_bytes<=0 OR charged_bytes%1024<>0)::text AS invalid
		 FROM backend_internal.${table}`, [table === 'work_capacity' ? capacityVersion : formulaVersion]);
		if (BigInt(sum.invalid) !== 0n) {
			throw new DiagnosticError('WORK_CAPACITY_RECONCILIATION_REQUIRED', { table });
		}
		rows += BigInt(sum.rows);
		bytes += BigInt(sum.bytes);
	}
	return { rows, bytes };
}

function withinLimits(rows: bigint, bytes: bigint): void {
	if (rows < 3n || rows > BigInt(workCapacity.rows) || bytes > BigInt(workCapacity.bytes) || bytes <= 0n) {
		throw new DiagnosticError('WORK_CAPACITY_LIMIT_EXCEEDED', {});
	}
}

export async function assertWorkCapacity(source: DataSource, formula = currentFormula): Promise<void> {
	await source.transaction('REPEATABLE READ', async manager => {
		const row = await manager.createQueryBuilder().select('capacity.*').from('backend_internal.work_capacity', 'capacity')
			.where("capacity_key='global'").getRawOne();
		if (!row || row.capacity_formula_version !== formula.formulaVersion || row.capacity_coefficient !== formula.coefficient) {
			throw new DiagnosticError('WORK_CAPACITY_RECONCILIATION_REQUIRED', {});
		}
		const sum = await totals(manager, formula.formulaVersion);
		withinLimits(sum.rows, sum.bytes);
		if (sum.rows !== BigInt(row.reserved_rows) || sum.bytes !== BigInt(row.reserved_bytes)) {
			throw new DiagnosticError('WORK_CAPACITY_RECONCILIATION_REQUIRED', {});
		}
	});
}

/** Services must be fully stopped. Locks protect against accidental concurrent writes during recalculation. */
export async function reconcileWorkCapacity(source: DataSource, target = currentFormula): Promise<void> {
	if (!Number.isSafeInteger(target.coefficient) || target.coefficient < 4 || target.coefficient > 2147483647
		|| !Number.isSafeInteger(target.formulaVersion) || target.formulaVersion < 1 || target.formulaVersion > 2147483647) {
		throw new Error('Invalid capacity formula');
	}
	await source.transaction(async manager => {
		await manager.query(`LOCK TABLE ${chargedTables.map(table => `backend_internal.${table}`).join(',')} IN ACCESS EXCLUSIVE MODE`);
		const row = await manager.createQueryBuilder().select('capacity.*').from('backend_internal.work_capacity', 'capacity')
			.where("capacity_key='global'").getRawOne();
		if (!row || row.capacity_coefficient < 4 || target.coefficient < row.capacity_coefficient
			|| target.formulaVersion < row.capacity_formula_version
			|| (target.coefficient !== row.capacity_coefficient && target.formulaVersion <= row.capacity_formula_version)) {
			throw new Error('Unsupported capacity formula change');
		}
		await totals(manager, row.capacity_formula_version);
		for (const table of chargedTables.filter(table => table !== 'work_capacity')) {
			// Scale saved aligned reservations upward: recalculating only present values would lose future-field headroom.
			await manager.createQueryBuilder().update(`backend_internal.${table}`).set({
				charged_bytes: () => '1024 * ceil(charged_bytes::numeric * :coefficient / :previous / 1024)',
				capacity_formula_version: target.formulaVersion,
			}).setParameters({ coefficient: target.coefficient, previous: row.capacity_coefficient }).execute();
		}
		const sum = await totals(manager, target.formulaVersion, row.capacity_formula_version);
		const previous = BigInt(row.capacity_coefficient);
		const capacityCharge = ((BigInt(row.charged_bytes) * BigInt(target.coefficient) + previous * 1024n - 1n) / (previous * 1024n)) * 1024n;
		sum.bytes += capacityCharge - BigInt(row.charged_bytes);
		withinLimits(sum.rows, sum.bytes);
		await manager.createQueryBuilder().update('backend_internal.work_capacity').set({
			charged_bytes: capacityCharge.toString(), capacity_formula_version: target.formulaVersion,
			reserved_rows: sum.rows.toString(), reserved_bytes: sum.bytes.toString(), capacity_coefficient: target.coefficient,
			physical_observed_at: null, physical_free_bytes: null, physical_total_bytes: null, physical_volume_id: null,
		}).where("capacity_key='global'").execute();
	});
}
