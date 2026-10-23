/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { schema } from '../post-work/schema.js';

const id = { type: 'varchar', length: 128 } as const;
export const apRecipientEntities = [schema({
	name: 'delivery_recipient',
	columns: {
		create_event_id: { ...id, primary: true }, inbox: { type: 'varchar', length: 2048, primary: true },
		request_id: id, note_id: id, actor_id: id, activity_id: { type: 'varchar', length: 2048 },
		shared: { type: 'boolean' }, send_state: { type: 'varchar', length: 32, default: 'pending' },
		fixed_at: { type: 'timestamptz' }, retain_until: { type: 'timestamptz' },
		capacity_formula_version: { type: 'integer', default: 1 }, charged_bytes: { type: 'bigint' },
	},
	foreignKeys: [{ name: 'delivery_recipient_request', target: 'work_request', columnNames: ['request_id'], referencedColumnNames: ['request_id'] }],
	checks: [
		{ name: 'send_state', expression: 'send_state IN (\'pending\',\'sending\',\'succeeded\',\'skipped\',\'cancelled\',\'failed_permanent\',\'unknown\',\'exhausted\',\'exhausted_unknown\')' },
		{ name: 'retention_bounds', expression: 'retain_until >= fixed_at' },
	],
	indices: [
		{ name: 'delivery_recipient_page', columns: ['request_id', 'inbox'] },
		{ name: 'delivery_recipient_retention', columns: ['retain_until', 'create_event_id'] },
	],
})];
