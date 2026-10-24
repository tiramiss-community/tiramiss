/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { schema } from '../post-work/schema.js';

export const apHostEntities = [schema({
	name: 'ap_host_lease',
	columns: {
		host: { type: 'varchar', length: 253, primary: true }, slot: { type: 'integer', primary: true },
		work_id: { type: 'varchar', length: 128, nullable: true },
		execution_owner: { type: 'varchar', length: 128, nullable: true }, execution_epoch: { type: 'bigint', nullable: true },
		lease_epoch: { type: 'bigint', default: 0 }, lease_id: { type: 'uuid', nullable: true },
		lease_until: { type: 'timestamptz', nullable: true }, last_used_at: { type: 'timestamptz' },
		capacity_formula_version: { type: 'integer', default: 1 }, charged_bytes: { type: 'bigint' },
	},
	uniques: [{ name: 'ap_host_lease_work', columns: ['work_id'] }],
	foreignKeys: [{ name: 'ap_host_lease_item', target: 'work_item', columnNames: ['work_id'], referencedColumnNames: ['work_id'] }],
	checks: [
		{ name: 'slot', expression: 'slot IN (0,1)' },
		{ name: 'epochs', expression: 'lease_epoch >= 0 AND (execution_epoch IS NULL OR execution_epoch > 0)' },
		{ name: 'ownership', expression: '(lease_id IS NULL AND lease_until IS NULL AND execution_owner IS NULL AND execution_epoch IS NULL) OR (lease_id IS NOT NULL AND lease_until IS NOT NULL AND execution_owner IS NOT NULL AND execution_epoch IS NOT NULL AND work_id IS NOT NULL AND lease_epoch > 0)' },
	],
	indices: [{ name: 'ap_host_lease_retention', columns: ['last_used_at', 'host', 'slot'] }],
})];
