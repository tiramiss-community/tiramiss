/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiModerationLog } from 'backend-upstream/entities';
import { evaluatePrivileges, selectApplicableRoles } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';
import type { QueueAudit } from '../../modules/queue/public.js';

export function createQueueActorReader(manager: EntityManager, createdAtFromId: (id: string) => number) {
	return async (userId: string, now: number) => {
		const facts = await readRoleAuthorizationFacts(manager, userId, createdAtFromId);
		const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
		return { isSuspended: facts.user.isSuspended, isModerator: evaluatePrivileges(userId, facts.instance.rootUserId, roles).isModerator };
	};
}

export async function appendQueueAudit(manager: EntityManager, record: QueueAudit, newId: (now: number) => string): Promise<void> {
	await manager.getRepository(MiModerationLog).insert({ id: newId(record.occurredAtMs), userId: record.actorId, type: record.type, info: {} });
}
