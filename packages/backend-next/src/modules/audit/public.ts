/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface RoleUpdateSnapshot {
	id: string;
	name: string;
	description: string;
	color: string | null;
	iconUrl: string | null;
	target: 'manual' | 'conditional';
	condFormula: unknown;
	policies: unknown;
	isPublic: boolean;
	isModerator: boolean;
	isAdministrator: boolean;
	isExplorable: boolean;
	asBadge: boolean;
	preserveAssignmentOnMoveAccount: boolean;
	canEditMembersByModerator: boolean;
	displayOrder: number;
	updatedAtMs: number;
	lastUsedAtMs: number;
}

export interface RoleUpdateAudit {
	actorId: string;
	roleId: string;
	before: RoleUpdateSnapshot;
	after: RoleUpdateSnapshot;
	occurredAtMs: number;
}
