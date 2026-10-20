/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { roleDefinition } from './role-mapping.js';
import type { EntityManager } from 'typeorm';
import type { RoleShowData } from '../../modules/role/public.js';

export function createRoleShowReader(manager: EntityManager, createdAtFromId: (id: string) => number) {
	return {
		async read(roleId: string, atMs: number): Promise<RoleShowData | null> {
			const row = await manager.getRepository(MiRole).findOneBy({ id: roleId });
			if (row === null) {
				return null;
			}
			const assignedCount = await manager.getRepository(MiRoleAssignment).createQueryBuilder('assignment')
				.where('assignment.roleId = :roleId', { roleId })
				.andWhere('(assignment.expiresAt IS NULL OR assignment.expiresAt > :at)', { at: new Date(atMs) })
				.getCount();
			return { role: roleDefinition(row), createdAtMs: createdAtFromId(row.id), assignedCount };
		},
	};
}
