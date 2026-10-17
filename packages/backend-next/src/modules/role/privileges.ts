/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole, RolePrivileges } from './model.js';

export function evaluatePrivileges(userId: string | null, rootUserId: string | null, roles: readonly EvaluationRole[]): RolePrivileges {
	if (userId === null) {
		return { isAdministrator: false, isModerator: false };
	}
	const isAdministrator = userId === rootUserId || roles.some(role => role.isAdministrator);
	return { isAdministrator, isModerator: isAdministrator || roles.some(role => role.isModerator) };
}
