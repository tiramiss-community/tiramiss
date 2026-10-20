/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DEFAULT_POLICIES, type RoleShowData } from '../modules/role/public.js';

export function roleResponse(data: RoleShowData) {
	const { role, createdAtMs, assignedCount } = data;
	const policies = { ...role.policies as Record<string, unknown> };
	for (const [key, value] of Object.entries(DEFAULT_POLICIES)) {
		if (policies[key] == null) {
			policies[key] = { useDefault: true, priority: 0, value: structuredClone(value) };
		}
	}
	return {
		id: role.id, createdAt: new Date(createdAtMs).toISOString(), updatedAt: new Date(role.updatedAtMs).toISOString(),
		name: role.name, description: role.description, color: role.color, iconUrl: role.iconUrl,
		target: role.target, condFormula: structuredClone(role.condFormula), isPublic: role.isPublic,
		isAdministrator: role.isAdministrator, isModerator: role.isModerator, isExplorable: role.isExplorable,
		asBadge: role.asBadge, preserveAssignmentOnMoveAccount: role.preserveAssignmentOnMoveAccount,
		canEditMembersByModerator: role.canEditMembersByModerator, displayOrder: role.displayOrder, policies, usersCount: assignedCount,
	};
}
