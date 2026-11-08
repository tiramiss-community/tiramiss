/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { roleAccessFacts } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';

export function createQueueActorReader(manager: EntityManager, createdAtFromId: (id: string) => number) {
	return async (userId: string, now: number) => {
		return roleAccessFacts(userId, await readRoleAuthorizationFacts(manager, userId, createdAtFromId), now);
	};
}

