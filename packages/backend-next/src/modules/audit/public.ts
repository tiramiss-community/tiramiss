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

/** 本家 `moderationLogTypes` のうち、新実装が記録する種別。記録を足す機能が自分の種別を追加する。 */
export type ModerationLogType = 'updateRole' | 'deleteNote' | 'clearQueue' | 'promoteQueue' | 'pauseQueue' | 'resumeQueue' | 'suspendRemoteInstance' | 'unsuspendRemoteInstance' | 'updateRemoteInstanceNote';

/** moderation_log へ追記する1件。`info` を省略すると本家と同じく空オブジェクトを保存する。 */
export interface ModerationLogEntry {
	actorId: string;
	type: ModerationLogType;
	info?: Record<string, unknown>;
	occurredAtMs: number;
}
