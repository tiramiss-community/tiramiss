/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface UserRoleFacts {
	userId: string;
	host: string | null;
	createdAtMs: number;
	isSuspended: boolean;
	isLocked: boolean;
	isBot: boolean;
	isCat: boolean;
	isExplorable: boolean;
	followersCount: number;
	followingCount: number;
	notesCount: number;
}

export interface RoleAssignment {
	id: string;
	userId: string;
	roleId: string;
	expiresAtMs: number | null;
}

export interface EvaluationRole {
	id: string;
	target: 'manual' | 'conditional';
	condFormula: unknown;
	policies: unknown;
	isAdministrator: boolean;
	isModerator: boolean;
}

export interface InstanceRoleFacts {
	rootUserId: string | null;
	basePolicies: Record<string, unknown>;
}

export interface RolePrivileges {
	isAdministrator: boolean;
	isModerator: boolean;
}
