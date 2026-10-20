/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createShowRole } from '../../../src/modules/role/show-role.js';
import { ActorSuspended, ModeratorRequired, CredentialScopeDenied, RoleNotFound } from '../../../src/modules/role/errors.js';
import { createAttemptEvaluation } from '../../../src/modules/role/evaluation.js';
import { atMs, role, user } from './fixtures.js';

const actor = { userId: 'user', credentialGrant: { readRole: true, updateRole: true } };

function setup() {
	const facts = { user: user(), instance: { rootUserId: 'user' as string | null, basePolicies: {} }, roles: [role()], assignments: [] };
	const data = { role: { ...role(), name: 'shown', description: '', color: null, iconUrl: null, updatedAtMs: atMs, lastUsedAtMs: atMs, isPublic: false, isExplorable: false, asBadge: false, preserveAssignmentOnMoveAccount: false, canEditMembersByModerator: false, displayOrder: 0 }, createdAtMs: 1, assignedCount: 2 };
	let reads = 0;
	const useCase = createShowRole({
		authorizationFacts: { read: async () => facts },
		roles: { read: async (id: string, at: number) => {
			reads++;
			expect(at).toBe(atMs);
			return id === 'manual' ? data : null;
		} },
	});
	return { facts, useCase, data, reads: () => reads };
}

test('returns fetched role and count after moderator authorization', async () => {
	const s = setup();
	expect(await s.useCase.showRole(actor, { roleId: 'manual' }, createAttemptEvaluation(atMs))).toEqual(s.data);
	expect(s.reads()).toBe(1);
});
test.each([ActorSuspended, ModeratorRequired, CredentialScopeDenied])('checks %s before input or existence', async error => {
	const s = setup();
	s.facts.user.isSuspended = error === ActorSuspended;
	s.facts.instance.rootUserId = error === ModeratorRequired ? null : 'user';
	await expect(s.useCase.showRole({ ...actor, credentialGrant: { readRole: false, updateRole: false } }, { roleId: '!' }, createAttemptEvaluation(atMs)))
		.rejects.toBeInstanceOf(error);
	expect(s.reads()).toBe(0);
});
test('checks input before role existence', async () => {
	const s = setup();
	await expect(s.useCase.showRole(actor, {}, createAttemptEvaluation(atMs))).rejects.toMatchObject({ param: '#/required' });
	expect(s.reads()).toBe(0);
	await expect(s.useCase.showRole(actor, { roleId: 'missing' }, createAttemptEvaluation(atMs))).rejects.toBeInstanceOf(RoleNotFound);
});
