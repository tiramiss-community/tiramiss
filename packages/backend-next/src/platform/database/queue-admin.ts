/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiModerationLog } from 'backend-upstream/entities';
import { roleAccessFacts } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';
import type { QueueAudit } from '../../modules/queue/public.js';

export function createQueueActorReader(manager: EntityManager, createdAtFromId: (id: string) => number) {
	return async (userId: string, now: number) => {
		return roleAccessFacts(userId, await readRoleAuthorizationFacts(manager, userId, createdAtFromId), now);
	};
}

export async function appendQueueAudit(manager: EntityManager, record: QueueAudit, newId: (now: number) => string): Promise<void> {
	await manager.getRepository(MiModerationLog).insert({ id: newId(record.occurredAtMs), userId: record.actorId, type: record.type, info: {} });
}
