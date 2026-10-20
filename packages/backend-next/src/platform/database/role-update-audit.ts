/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiModerationLog } from 'backend-upstream/entities';
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
	await manager.getRepository(MiModerationLog).createQueryBuilder().insert().values({
		id: newId(record.occurredAtMs), userId: record.actorId, type: 'updateRole',
		info: () => 'CAST(:info AS jsonb)',
	}).setParameter('info', JSON.stringify({
		roleId: record.roleId, before: snapshot(record.before), after: snapshot(record.after),
	})).execute();
}
