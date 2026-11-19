/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { evaluatePolicies, selectApplicableRoles } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import { readMeta } from './meta.js';
import type { EntityManager } from 'typeorm';

export async function readStreamingTimelinePolicies(manager: EntityManager, userId: string | null, createdAtFromId: (id: string) => number, now: number): Promise<{ ltlAvailable: boolean; gtlAvailable: boolean }> {
	if (userId === null) {
		return evaluatePolicies({ userId, roles: [], basePolicies: (await readMeta(manager)).policies, uploadLimitBytes: 0 });
	}
	const facts = await readRoleAuthorizationFacts(manager, userId, createdAtFromId);
	const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
	return evaluatePolicies({ userId, roles, basePolicies: facts.instance.basePolicies, uploadLimitBytes: 0 });
}
