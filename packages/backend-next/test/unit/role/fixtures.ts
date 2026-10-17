/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole, RoleAssignment, UserRoleFacts } from '../../../src/modules/role/model.js';

export const atMs = Date.parse('2026-10-14T12:00:00.000Z');

export function user(overrides: Partial<UserRoleFacts> = {}): UserRoleFacts {
	return {
		userId: 'user', host: null, createdAtMs: atMs - 10000,
		isSuspended: false, isLocked: true, isBot: true, isCat: false, isExplorable: true,
		followersCount: 10, followingCount: 20, notesCount: 30, ...overrides,
	};
}

export function role(overrides: Partial<EvaluationRole> = {}): EvaluationRole {
	return {
		id: 'manual', target: 'manual', condFormula: {}, policies: {},
		isAdministrator: false, isModerator: false, ...overrides,
	};
}

export function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
	return { id: 'assignment', userId: 'user', roleId: 'manual', expiresAtMs: null, ...overrides };
}

export function policy(value: unknown, priority = 0, useDefault = false) {
	return { value, priority, useDefault };
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
