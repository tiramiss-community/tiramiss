/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole, RoleAssignment, UserRoleFacts } from './model.js';
import { evaluateCondition } from './condition.js';

export function selectAssignedRoles(roles: readonly EvaluationRole[], assignments: readonly RoleAssignment[], userId: string, atMs: number): readonly EvaluationRole[] {
	const assignedIds = new Set(assignments
		.filter(assignment => assignment.userId === userId && (assignment.expiresAtMs === null || assignment.expiresAtMs > atMs))
		.map(assignment => assignment.roleId));
	return roles.filter(role => assignedIds.has(role.id));
}

export function selectApplicableRoles(roles: readonly EvaluationRole[], assignments: readonly RoleAssignment[], user: UserRoleFacts, atMs: number): readonly EvaluationRole[] {
	const assigned = selectAssignedRoles(roles, assignments, user.userId, atMs);
	const conditional = roles.filter(role => role.target === 'conditional' && evaluateCondition(role.condFormula, user, assigned, atMs));
	return [...assigned, ...conditional];
}
