/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ActorSuspended, ModeratorRequired, CredentialScopeDenied, RoleNotFound } from './errors.js';
import { selectApplicableRoles } from './applicable-roles.js';
import { evaluatePrivileges } from './privileges.js';
import { prepareRoleInput } from './input.js';
import type { RoleActor, RoleAuthorizationFacts, RoleDefinition } from './update-contract.js';
import type { RoleEvaluation } from './evaluation.js';

export interface RoleShowData {
	role: RoleDefinition;
	createdAtMs: number;
	assignedCount: number;
}

export function createShowRole(dependencies: {
	authorizationFacts: { read(actorId: string): Promise<RoleAuthorizationFacts> };
	roles: { read(roleId: string, atMs: number): Promise<RoleShowData | null> };
}) {
	return {
		async showRole(actor: RoleActor, rawInput: unknown, evaluation: RoleEvaluation): Promise<RoleShowData> {
			const readInput = prepareRoleInput(rawInput, 'show');
			const facts = await dependencies.authorizationFacts.read(actor.userId);
			if (facts.user.isSuspended) {
				throw new ActorSuspended();
			}

			const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, evaluation.atMs);
			if (!evaluatePrivileges(actor.userId, facts.instance.rootUserId, roles).isModerator) {
				throw new ModeratorRequired();
			}
			if (!actor.credentialGrant.readRole) {
				throw new CredentialScopeDenied();
			}

			const { roleId } = readInput();
			const data = await dependencies.roles.read(roleId, evaluation.atMs);
			if (data === null) {
				throw new RoleNotFound();
			}
			return data;
		},
	};
}
