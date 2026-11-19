/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EntitySchema } from 'typeorm';

const id = { type: 'varchar', length: 128 } as const;
const columns = {
	notification_id: { ...id, primary: true }, recipient_id: id,
	notification_type: { type: 'varchar', length: 32 } as const,
	notifier_id: { ...id, nullable: true }, note_id: { ...id, nullable: true }, achievement: { ...id, nullable: true }, target_note_id: { ...id, nullable: true },
	created_at: { type: 'timestamptz' } as const,
};

export const notificationEntities = [new EntitySchema({
	name: 'notification',
	schema: 'backend_internal',
	columns,
	checks: [
		{ name: 'notification_type', expression: "notification_type IN ('reply','mention','quote','renote','note','pollEnded','achievementEarned')" },
		{ name: 'notification_achievement', expression: "(notification_type = 'achievementEarned') = (achievement IS NOT NULL) AND (notification_type = 'achievementEarned') = (note_id IS NULL)" },
		{ name: 'notification_target', expression: "(notification_type = 'renote') = (target_note_id IS NOT NULL)" },
		{ name: 'notification_notifier', expression: "(notification_type IN ('pollEnded','achievementEarned')) = (notifier_id IS NULL)" },
		...Object.entries(columns).filter(([, column]) => column.type === 'varchar').map(([name, column]) => ({
			name: `notification_bytes_${name}`,
			expression: `octet_length("${name}") BETWEEN 1 AND ${'length' in column ? column.length : 128}`,
		})),
	],
	indices: [{ name: 'notification_recipient_order', columns: ['recipient_id', 'created_at', 'notification_id'] }],
})];
