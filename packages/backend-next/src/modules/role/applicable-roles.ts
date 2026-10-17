/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole, RoleAssignment, UserRoleFacts } from './model.js';
import { evaluateCondition } from './condition.js';

export function selectApplicableRoles(roles: readonly EvaluationRole[], assignments: readonly RoleAssignment[], user: UserRoleFacts, atMs: number): readonly EvaluationRole[] {
	const assignedIds = new Set(assignments
		.filter(assignment => assignment.userId === user.userId && (assignment.expiresAtMs === null || assignment.expiresAtMs > atMs))
		.map(assignment => assignment.roleId));
	const assigned = roles.filter(role => assignedIds.has(role.id));
	const conditional = roles.filter(role => role.target === 'conditional' && evaluateCondition(role.condFormula, user, assigned, atMs));
	return [...assigned, ...conditional];
}
