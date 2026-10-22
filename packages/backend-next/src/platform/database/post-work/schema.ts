/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EntitySchema } from 'typeorm';
import type { EntitySchemaColumnOptions, EntitySchemaOptions } from 'typeorm';

const id = { type: 'varchar', length: 128 } as const;
const time = { type: 'timestamptz' } as const;
const accounting: Record<string, EntitySchemaColumnOptions> = {
	capacity_formula_version: { type: 'integer', default: 1 },
	charged_bytes: { type: 'bigint' },
};
const accountingChecks = [
	{ name: 'formula_positive', expression: 'capacity_formula_version > 0' },
	{ name: 'charge_positive', expression: 'charged_bytes > 0 AND charged_bytes % 1024 = 0' },
];

export function schema(options: EntitySchemaOptions<object>): EntitySchema {
	const checks = [...accountingChecks, ...options.checks ?? []];
	for (const [name, column] of Object.entries(options.columns)) {
		if (column?.type === 'varchar') {
			checks.push({ name: `bytes_${name}`, expression: `octet_length("${name}") BETWEEN 1 AND ${column.length}` });
		}
	}
	return new EntitySchema<object>({
		...options, schema: 'backend_internal',
		checks: checks.map(check => ({ ...check, name: `${options.name}_${check.name}` })),
	});
}

export const postWorkEntities = [
	schema({
		name: 'note_work_state',
		columns: {
			note_id: { ...id, primary: true }, actor_id: id,
			generation: { type: 'integer' }, create_event_id: { ...id, nullable: true }, cancel_event_id: { ...id, nullable: true },
			visibility: { type: 'varchar', length: 16 }, local_only: { type: 'boolean' }, channel_id: { ...id, nullable: true },
			deleted_at: { ...time, nullable: true }, recipient_coverage: { type: 'varchar', length: 16 },
			recipients_fixed_at: { ...time, nullable: true }, last_dependency_at: time,
			...accounting,
		},
		checks: [
			{ name: 'generation', expression: 'generation >= 1' },
			{ name: 'visibility', expression: "visibility IN ('public','home','followers','specified')" },
			{ name: 'coverage', expression: "recipient_coverage IN ('not_started','fixed','expired','unavailable')" },
			{ name: 'channel', expression: "channel_id IS NULL OR (local_only AND visibility='public')" },
			{ name: 'cancellation', expression: '(generation = 1 AND deleted_at IS NULL AND cancel_event_id IS NULL AND create_event_id IS NOT NULL) OR (generation >= 2 AND deleted_at IS NOT NULL AND cancel_event_id IS NOT NULL)' },
		],
		indices: [{ name: 'note_work_retention', columns: ['last_dependency_at', 'note_id'] }],
	}),
	schema({
		name: 'work_request',
		columns: {
			request_id: { ...id, primary: true }, event_id: id, note_id: id, actor_id: id,
			note_generation: { type: 'integer' }, kind: { type: 'varchar', length: 64 }, schema_version: { type: 'integer' },
			note_facts: { type: 'jsonb' }, payload: { type: 'text', nullable: true }, payload_hash: { type: 'varchar', length: 64 },
			occurred_at: time, not_before: time, deadline_at: time,
			state: { type: 'varchar', length: 32, default: 'open' }, finished_at: { ...time, nullable: true },
			...accounting,
		},
		uniques: [{ name: 'work_request_business_key', columns: ['event_id', 'kind', 'note_generation'] }],
		foreignKeys: [{ name: 'work_request_note', target: 'note_work_state', columnNames: ['note_id'], referencedColumnNames: ['note_id'] }],
		checks: [
			{ name: 'version', expression: 'schema_version > 0 AND note_generation >= 1' },
			{ name: 'times', expression: 'occurred_at <= not_before AND not_before < deadline_at' },
			{ name: 'state', expression: "state IN ('open','settled','needs_attention')" },
			{ name: 'hash', expression: "payload_hash ~ '^[a-f0-9]{64}$'" },
			{ name: 'payload', expression: "payload IS NULL OR (jsonb_typeof(payload::jsonb) = 'object' AND octet_length(payload) <= 2097152)" },
			{ name: 'note_facts', expression: "jsonb_typeof(note_facts) = 'object' AND octet_length(note_facts::text) <= 2048" },
		],
		indices: [
			{ name: 'work_request_note_generation', columns: ['note_id', 'note_generation'] },
			{ name: 'work_request_retention', columns: ['finished_at', 'request_id'] },
		],
	}),
	schema({
		name: 'work_item',
		columns: {
			work_id: { ...id, primary: true }, request_id: id, kind: { type: 'varchar', length: 64 },
			target_key: { type: 'varchar', length: 2048 }, schema_version: { type: 'integer' },
			payload: { type: 'text', nullable: true }, payload_hash: { type: 'varchar', length: 64 },
			state: { type: 'varchar', length: 32, default: 'ready' }, next_attempt_at: time, deadline_at: time,
			attempt_count: { type: 'integer', default: 0 },
			dispatch_owner: { ...id, nullable: true }, dispatch_until: { ...time, nullable: true }, dispatch_epoch: { type: 'bigint', default: 0 },
			execution_owner: { ...id, nullable: true }, execution_until: { ...time, nullable: true }, execution_epoch: { type: 'bigint', default: 0 },
			dispatch_seq: { type: 'bigint', default: 0 }, last_enqueued_at: { ...time, nullable: true },
			last_outcome: { type: 'varchar', length: 32, nullable: true }, reason_code: { type: 'varchar', length: 64, nullable: true },
			reason_summary: { type: 'varchar', length: 256, nullable: true }, result_ref: { ...id, nullable: true }, finished_at: { ...time, nullable: true },
			...accounting,
		},
		uniques: [{ name: 'work_item_target', columns: ['request_id', 'kind', 'target_key'] }],
		foreignKeys: [{ name: 'work_item_request', target: 'work_request', columnNames: ['request_id'], referencedColumnNames: ['request_id'] }],
		checks: [
			{ name: 'version', expression: 'schema_version > 0' },
			{ name: 'counters', expression: 'attempt_count >= 0 AND dispatch_epoch >= 0 AND execution_epoch >= 0 AND dispatch_seq >= 0' },
			{ name: 'state', expression: "state IN ('ready','retry_wait','running','succeeded','skipped','cancelled','failed_permanent','exhausted','exhausted_unknown','quarantined')" },
			{ name: 'dispatch_lease', expression: '(dispatch_owner IS NULL) = (dispatch_until IS NULL)' },
			{ name: 'execution_lease', expression: '(execution_owner IS NULL) = (execution_until IS NULL)' },
			{ name: 'hash', expression: "payload_hash ~ '^[a-f0-9]{64}$'" },
			{ name: 'payload', expression: "payload IS NULL OR (jsonb_typeof(payload::jsonb) = 'object' AND octet_length(payload) <= 2097152)" },
		],
		indices: [
			{ name: 'work_item_dispatch_scan', columns: ['next_attempt_at', 'work_id'], where: "state IN ('ready','retry_wait','running')" },
			{ name: 'work_item_deadline_scan', columns: ['deadline_at', 'work_id'], where: "state IN ('ready','retry_wait','running')" },
			{ name: 'work_item_retention', columns: ['finished_at', 'work_id'] },
		],
	}),
	schema({
		name: 'work_capacity',
		columns: { capacity_key: { type: 'varchar', length: 32, primary: true }, reserved_rows: { type: 'bigint' }, reserved_bytes: { type: 'bigint' }, ...accounting },
		checks: [
			{ name: 'key', expression: "capacity_key = 'global'" },
			{ name: 'bounds', expression: 'reserved_rows BETWEEN 1 AND 1000000 AND reserved_bytes BETWEEN charged_bytes AND 21474836480' },
		],
	}),
];
