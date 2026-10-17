/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { RoleUpdateAudit, RoleUpdateSnapshot } from '../audit/public.js';
import type { EvaluationRole, InstanceRoleFacts, RoleAssignment, UserRoleFacts } from './model.js';

export interface RoleDefinition extends RoleUpdateSnapshot, EvaluationRole {}

export type RolePatch = Partial<Omit<RoleDefinition, 'id' | 'updatedAtMs' | 'lastUsedAtMs'>>;

export interface RoleActor {
	userId: string;
	credentialGrant: { readRole: boolean; updateRole: boolean };
}

export interface RoleAuthorizationFacts {
	user: UserRoleFacts;
	instance: InstanceRoleFacts;
	roles: readonly EvaluationRole[];
	assignments: readonly RoleAssignment[];
}

export interface RoleUpdateScope {
	roles: {
		getForUpdate(roleId: string): Promise<RoleDefinition | null>;
		savePatch(roleId: string, patch: RolePatch, updatedAtMs: number): Promise<RoleDefinition>;
	};
	authorizationFacts: { read(actorId: string): Promise<RoleAuthorizationFacts> };
	auditLogs: { appendRoleUpdate(record: RoleUpdateAudit): Promise<void> };
}

export interface RoleDefinitionsChanged {
	kind: 'role-definitions-changed';
	roleId: string;
}

export interface RoleChanges {
	invalidateLocal(change: RoleDefinitionsChanged): void;
	publish(change: RoleDefinitionsChanged): Promise<void>;
}
