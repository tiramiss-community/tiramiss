/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiMeta, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { RoleAuthorizationFacts } from '../../modules/role/public.js';
import { ActorNotFound } from '../../modules/role/public.js';
import { roleDefinition } from './role-mapping.js';

export async function readRoleAuthorizationFacts(
	manager: EntityManager,
	actorId: string,
	createdAtFromId: (id: string) => number,
): Promise<RoleAuthorizationFacts> {
	const user = await manager.getRepository(MiUser).findOneBy({ id: actorId });
	if (user === null) {
		throw new ActorNotFound();
	}
	const instance = await manager.getRepository(MiMeta).findOneByOrFail({});
	const roles = await manager.getRepository(MiRole).find();
	const assignments = await manager.getRepository(MiRoleAssignment).findBy({ userId: actorId });
	return {
		user: {
			userId: user.id, host: user.host, createdAtMs: createdAtFromId(user.id),
			isSuspended: user.isSuspended, isLocked: user.isLocked, isBot: user.isBot,
			isCat: user.isCat, isExplorable: user.isExplorable,
			followersCount: user.followersCount, followingCount: user.followingCount, notesCount: user.notesCount,
		},
		instance: { rootUserId: instance.rootUserId, basePolicies: structuredClone(instance.policies) },
		roles: roles.map(roleDefinition),
		assignments: assignments.map(row => ({
			id: row.id, userId: row.userId, roleId: row.roleId, expiresAtMs: row.expiresAt?.getTime() ?? null,
		})),
	};
}
