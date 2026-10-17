/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole, UserRoleFacts } from './model.js';

export function evaluateCondition(formula: unknown, user: UserRoleFacts, assignedRoles: readonly EvaluationRole[], atMs: number): boolean {
	try {
		if (formula === null || typeof formula !== 'object') {
			return false;
		}
		const value = formula as Record<string, unknown>;
		const evaluate = (child: unknown) => evaluateCondition(child, user, assignedRoles, atMs);

		switch (value.type) {
			case 'and':
				return Array.isArray(value.values) && value.values.every(evaluate);
			case 'or':
				return Array.isArray(value.values) && value.values.some(evaluate);
			case 'not':
				return !evaluate(value.value);
			case 'roleAssignedTo':
				return assignedRoles.some(role => role.id === value.roleId);
			case 'isLocal':
				return user.host === null;
			case 'isRemote':
				return user.host !== null;
			case 'isSuspended':
				return user.isSuspended;
			case 'isLocked':
				return user.isLocked;
			case 'isBot':
				return user.isBot;
			case 'isCat':
				return user.isCat;
			case 'isExplorable':
				return user.isExplorable;
			case 'createdLessThan':
				return user.createdAtMs > atMs - Number(value.sec) * 1000;
			case 'createdMoreThan':
				return user.createdAtMs < atMs - Number(value.sec) * 1000;
			case 'followersLessThanOrEq':
				return user.followersCount <= Number(value.value);
			case 'followersMoreThanOrEq':
				return user.followersCount >= Number(value.value);
			case 'followingLessThanOrEq':
				return user.followingCount <= Number(value.value);
			case 'followingMoreThanOrEq':
				return user.followingCount >= Number(value.value);
			case 'notesLessThanOrEq':
				return user.notesCount <= Number(value.value);
			case 'notesMoreThanOrEq':
				return user.notesCount >= Number(value.value);
			default:
				return false;
		}
	} catch {
		// 保存された壊れた子条件も個別にfalseとし、親のnot/and/orの意味を維持する。
		return false;
	}
}
