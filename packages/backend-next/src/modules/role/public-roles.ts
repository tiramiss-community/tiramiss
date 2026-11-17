/*
	* SPDX-FileCopyrightText: syuilo and misskey-project
	* SPDX-License-Identifier: AGPL-3.0-only
	*/
import { compileInput, requireCredential } from '../access/public.js';
import { roleAccessFacts } from './access.js';
import { selectApplicableRoles } from './applicable-roles.js';
import { RoleNotFound } from './errors.js';
import { prepareRoleInput } from './input.js';
import type { AccessRequest } from '../access/public.js';
import type { RoleEvaluation } from './evaluation.js';
import type { RoleAssignment, UserRoleFacts } from './model.js';
import type { RoleShowData } from './show-role.js';
import type { RoleAuthorizationFacts, RoleDefinition } from './update-contract.js';

const parseListInput = compileInput({ type: 'object', properties: {}, required: [] });

export function createPublicRoles(dependencies: {
	authorizationFacts: { read(actorId: string): Promise<RoleAuthorizationFacts> };
	roles: {
		readPublic(roleId: string, atMs: number): Promise<RoleShowData | null>;
		listPublic(atMs: number): Promise<RoleShowData[]>;
	};
}) {
	return {
		async showPublicRole(_access: AccessRequest, input: unknown, evaluation: RoleEvaluation): Promise<RoleShowData> {
			const { roleId } = prepareRoleInput(input, 'show')();
			const data = await dependencies.roles.readPublic(roleId, evaluation.atMs);
			if (data === null) {
				throw new RoleNotFound();
			}
			return data;
		},
		async listPublicRoles(access: AccessRequest, input: unknown, evaluation: RoleEvaluation): Promise<RoleShowData[]> {
			const actor = requireCredential(access.credential);
			const facts = await dependencies.authorizationFacts.read(actor.userId);
			access.authorize(roleAccessFacts(actor.userId, facts, evaluation.atMs));
			parseListInput(input);
			return dependencies.roles.listPublic(evaluation.atMs);
		},
	};
}

/** UserDetailed's roles field, from already fetched facts; equal display orders retain source order. */
export function userRoleMaterials(roles: readonly RoleDefinition[], assignments: readonly RoleAssignment[], user: UserRoleFacts, atMs: number) {
	const definitions = new Map(roles.map(role => [role.id, role]));
	return selectApplicableRoles(roles, assignments, user, atMs)
		.map(role => definitions.get(role.id)!)
		.filter(role => role.isPublic)
		.sort((a, b) => b.displayOrder - a.displayOrder)
		.map(role => ({ id: role.id, name: role.name, color: role.color, iconUrl: role.iconUrl, description: role.description, isModerator: role.isModerator, isAdministrator: role.isAdministrator, displayOrder: role.displayOrder }));
}
