/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MiRole } from 'backend-upstream/entities';
import type { RoleDefinition, RolePatch } from '../../modules/role/public.js';

const patchFields = [
	'name', 'description', 'color', 'iconUrl', 'target', 'condFormula', 'policies',
	'isPublic', 'isModerator', 'isAdministrator', 'isExplorable', 'asBadge',
	'preserveAssignmentOnMoveAccount', 'canEditMembersByModerator', 'displayOrder',
] as const satisfies readonly (keyof RolePatch)[];

export function rolePatchColumns(patch: RolePatch): Record<string, unknown> {
	return Object.fromEntries(patchFields
		.filter(key => Object.hasOwn(patch, key) && patch[key] !== undefined)
		.map(key => [key, patch[key]]));
}

export function roleDefinition(row: MiRole): RoleDefinition {
	return {
		id: row.id, name: row.name, description: row.description, color: row.color, iconUrl: row.iconUrl,
		target: row.target, condFormula: structuredClone(row.condFormula), policies: structuredClone(row.policies),
		isPublic: row.isPublic, isModerator: row.isModerator, isAdministrator: row.isAdministrator,
		isExplorable: row.isExplorable, asBadge: row.asBadge,
		preserveAssignmentOnMoveAccount: row.preserveAssignmentOnMoveAccount,
		canEditMembersByModerator: row.canEditMembersByModerator, displayOrder: row.displayOrder,
		updatedAtMs: row.updatedAt.getTime(), lastUsedAtMs: row.lastUsedAt.getTime(),
	};
}
