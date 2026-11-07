/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import { selectApplicableRoles, selectAssignedRoles } from '../../modules/role/public.js';
import type { UserRoleFacts } from '../../modules/role/public.js';
import type { RoleMaterialReader } from '../role-material-cache.js';

export function createRoleTimelineReader(manager: EntityManager, materials: RoleMaterialReader, createdAtFromId: (id: string) => number) {
	return {
		async roleIds(userId: string, now: number): Promise<string[]> {
			const roles = await materials.readRoles();
			const assignments = await materials.readAssignments(userId);
			if (!roles.some(role => role.target === 'conditional')) {
				return selectAssignedRoles(roles, assignments, userId, now).map(role => role.id);
			}
			const row = await manager.getRepository(MiUser).findOneByOrFail({ id: userId });
			const user: UserRoleFacts = {
				userId, host: row.host, createdAtMs: createdAtFromId(row.id),
				isSuspended: row.isSuspended, isLocked: row.isLocked, isBot: row.isBot, isCat: row.isCat, isExplorable: row.isExplorable,
				followersCount: row.followersCount, followingCount: row.followingCount, notesCount: row.notesCount,
			};
			return selectApplicableRoles(roles, assignments, user, now).map(role => role.id);
		},
	};
}
