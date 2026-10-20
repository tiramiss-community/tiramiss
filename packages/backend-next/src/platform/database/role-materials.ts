/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { RoleMaterialReader } from '../role-material-cache.js';
import { roleDefinition } from './role-mapping.js';

export function createRoleMaterialReader(manager: EntityManager): RoleMaterialReader {
	return {
		readRoles: async () => (await manager.getRepository(MiRole).find()).map(roleDefinition),
		readAssignments: async userId => (await manager.getRepository(MiRoleAssignment).findBy({ userId })).map(row => ({
			id: row.id, userId: row.userId, roleId: row.roleId, expiresAtMs: row.expiresAt?.getTime() ?? null,
		})),
	};
}
