/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { appendModerationLog } from './moderation-log.js';
import type { EntityManager } from 'typeorm';
import type { RoleUpdateAudit, RoleUpdateSnapshot } from '../../modules/audit/public.js';

function snapshot(value: RoleUpdateSnapshot) {
	const { updatedAtMs, lastUsedAtMs, ...fields } = value;
	return {
		...fields,
		updatedAt: new Date(updatedAtMs).toISOString(),
		lastUsedAt: new Date(lastUsedAtMs).toISOString(),
	};
}

export async function appendRoleUpdateAudit(
	manager: EntityManager,
	record: RoleUpdateAudit,
	newId: (occurredAtMs: number) => string,
): Promise<void> {
	await appendModerationLog(manager, {
		actorId: record.actorId, type: 'updateRole', occurredAtMs: record.occurredAtMs,
		info: { roleId: record.roleId, before: snapshot(record.before), after: snapshot(record.after) },
	}, newId);
}
