/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { userRoleMaterials } from '../../modules/role/public.js';
import { createRoleMaterialReader } from './role-materials.js';
import { roleDefinition } from './role-mapping.js';
import type { EntityManager } from 'typeorm';
import type { MiRole as RoleRow } from 'backend-upstream/entities';
import type { UserRoleFacts } from '../../modules/role/public.js';
import type { RoleShowData } from '../../modules/role/public.js';

export function createRoleShowReader(manager: EntityManager, createdAtFromId: (id: string) => number) {
	const material = createRoleMaterialReader(manager);
	const present = (row: RoleRow, assignedCount: number): RoleShowData => ({ role: roleDefinition(row), createdAtMs: createdAtFromId(row.id), assignedCount });
	const pack = async (row: RoleRow, atMs: number): Promise<RoleShowData> => {
		const assignedCount = await manager.getRepository(MiRoleAssignment).createQueryBuilder('assignment')
			.where('assignment.roleId = :roleId', { roleId: row.id })
			.andWhere('(assignment.expiresAt IS NULL OR assignment.expiresAt > :at)', { at: new Date(atMs) })
			.getCount();
		return present(row, assignedCount);
	};
	return {
		async listPublic(atMs: number): Promise<RoleShowData[]> {
			const rows = await manager.getRepository(MiRole).findBy({ isPublic: true, isExplorable: true });
			if (rows.length === 0) {
				return [];
			}
			const counts = await manager.getRepository(MiRoleAssignment).createQueryBuilder('assignment')
				.select('assignment.roleId', 'roleId').addSelect('COUNT(*)', 'count')
				.where('assignment.roleId IN (:...roleIds)', { roleIds: rows.map(row => row.id) })
				.andWhere('(assignment.expiresAt IS NULL OR assignment.expiresAt > :at)', { at: new Date(atMs) })
				.groupBy('assignment.roleId').getRawMany<{ roleId: string; count: string }>();
			const byRole = new Map(counts.map(row => [row.roleId, Number(row.count)]));
			return rows.map(row => present(row, byRole.get(row.id) ?? 0));
		},
		async readPublic(roleId: string, atMs: number): Promise<RoleShowData | null> {
			const row = await manager.getRepository(MiRole).findOneBy({ id: roleId, isPublic: true });
			return row === null ? null : pack(row, atMs);
		},
		async readUserRoles(user: UserRoleFacts, atMs: number) {
			const [roles, assignments] = await Promise.all([manager.getRepository(MiRole).find().then(rows => rows.map(roleDefinition)), material.readAssignments(user.userId)]);
			return userRoleMaterials(roles, assignments, user, atMs);
		},
		async read(roleId: string, atMs: number): Promise<RoleShowData | null> {
			const row = await manager.getRepository(MiRole).findOneBy({ id: roleId });
			if (row === null) {
				return null;
			}
			return pack(row, atMs);
		},
	};
}
