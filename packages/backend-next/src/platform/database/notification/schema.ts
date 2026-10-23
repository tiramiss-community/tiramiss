/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { schema } from '../post-work/schema.js';

const id = { type: 'varchar', length: 128 } as const;
const accounting = { capacity_formula_version: { type: 'integer', default: 1 }, charged_bytes: { type: 'bigint' } } as const;
const type = { type: 'varchar', length: 16 } as const;
const typeCheck = "notification_type IN ('reply','mention','quote','renote','note')";

export const notificationEntities = [
	schema({
		name: 'notification',
		columns: {
			notification_id: { ...id, primary: true }, recipient_id: id, notification_type: type,
			notifier_id: id, note_id: id, target_note_id: { ...id, nullable: true },
			created_at: { type: 'timestamptz' }, ...accounting,
		},
		checks: [
			{ name: 'type', expression: typeCheck },
			{ name: 'target', expression: "(notification_type = 'renote') = (target_note_id IS NOT NULL)" },
		],
		indices: [{ name: 'notification_recipient_order', columns: ['recipient_id', 'created_at', 'notification_id'] }],
	}),
	schema({
		name: 'notification_effect',
		columns: {
			request_id: { ...id, primary: true }, recipient_id: { ...id, primary: true }, notification_type: { ...type, primary: true },
			notification_id: { ...id, nullable: true }, reason_code: { type: 'varchar', length: 64, nullable: true },
			formed_at: { type: 'timestamptz' }, ...accounting,
		},
		foreignKeys: [{ name: 'notification_effect_request', target: 'work_request', columnNames: ['request_id'], referencedColumnNames: ['request_id'] }],
		checks: [
			{ name: 'type', expression: typeCheck },
			{ name: 'outcome', expression: '(notification_id IS NULL) <> (reason_code IS NULL)' },
			{ name: 'reason', expression: "reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]*$'" },
		],
		indices: [{ name: 'notification_effect_retention', columns: ['formed_at', 'request_id'] }],
	}),
];
