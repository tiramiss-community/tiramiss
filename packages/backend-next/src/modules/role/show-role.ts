/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { requireCredential } from '../access/public.js';
import { RoleNotFound } from './errors.js';
import { roleAccessFacts } from './access.js';
import { prepareRoleInput } from './input.js';
import type { AccessRequest } from '../access/public.js';
import type { RoleAuthorizationFacts, RoleDefinition } from './update-contract.js';
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
		async showRole(access: AccessRequest, rawInput: unknown, evaluation: RoleEvaluation): Promise<RoleShowData> {
			const readInput = prepareRoleInput(rawInput, 'show');
			const actor = requireCredential(access.credential);
			const facts = await dependencies.authorizationFacts.read(actor.userId);
			access.authorize(roleAccessFacts(actor.userId, facts, evaluation.atMs));

			const { roleId } = readInput();
			const data = await dependencies.roles.read(roleId, evaluation.atMs);
			if (data === null) {
				throw new RoleNotFound();
			}
			return data;
		},
	};
}
