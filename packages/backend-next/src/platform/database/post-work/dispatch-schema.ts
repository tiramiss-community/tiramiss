/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { schema } from './schema.js';

const id = { type: 'varchar', length: 128 } as const;
const time = { type: 'timestamptz' } as const;
const accounting = {
	capacity_formula_version: { type: 'integer' as const, default: 1 },
	charged_bytes: { type: 'bigint' as const },
};

export const dispatchEntities = [
	schema({
		name: 'work_control',
		columns: {
			queue_key: { type: 'varchar', length: 32, primary: true },
			queue_generation: { type: 'bigint', default: 1 }, paused: { type: 'boolean', default: false },
			recovery_pending: { type: 'boolean', default: false },
			reserved_dispatches: { type: 'integer', default: 0 }, ...accounting,
		},
		checks: [
			{ name: 'queue', expression: "queue_key IN ('deliver','postLocal')" },
			{ name: 'generation', expression: 'queue_generation > 0' },
			{ name: 'bounds', expression: 'reserved_dispatches BETWEEN 0 AND 10000' },
		],
	}),
	schema({
		name: 'queue_dispatch',
		columns: {
			work_id: { ...id, primary: true }, dispatch_seq: { type: 'bigint', primary: true },
			queue_key: { type: 'varchar', length: 32 }, queue_generation: { type: 'bigint' }, token: id,
			token_expires_at: time, reserved_at: time, last_checked_at: time,
			state: { type: 'varchar', length: 32, default: 'reserved' }, released_at: { ...time, nullable: true },
			...accounting,
		},
		foreignKeys: [
			{ name: 'dispatch_item', target: 'work_item', columnNames: ['work_id'], referencedColumnNames: ['work_id'] },
			{ name: 'dispatch_queue', target: 'work_control', columnNames: ['queue_key'], referencedColumnNames: ['queue_key'] },
		],
		checks: [
			{ name: 'counters', expression: 'dispatch_seq > 0 AND queue_generation > 0' },
			{ name: 'expiry', expression: "token_expires_at = reserved_at + interval '60 seconds'" },
			{ name: 'state', expression: "state IN ('reserved','enqueue_unknown','enqueued','retired','released')" },
			{ name: 'released', expression: "(state = 'released') = (released_at IS NOT NULL)" },
		],
		indices: [
			{ name: 'dispatch_pending', columns: ['last_checked_at', 'work_id', 'dispatch_seq'], where: "state <> 'released'" },
			{ name: 'dispatch_retention', columns: ['released_at', 'work_id', 'dispatch_seq'] },
		],
	}),
];
