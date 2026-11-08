/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createShowRole } from '../../../src/modules/role/show-role.js';
import { RoleNotFound } from '../../../src/modules/role/errors.js';
import { createAttemptEvaluation } from '../../../src/modules/role/evaluation.js';
import { atMs, role, user } from './fixtures.js';
import { createAccessRequest, type AccessCredential } from '../../../src/modules/access/public.js';

const request = (credential: AccessCredential | null) => createAccessRequest({ requireModerator: true, kind: 'read:admin:roles' }, credential);
const actor = { userId: 'user', native: true } as const;

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
	expect(await s.useCase.showRole(request(actor), { roleId: 'manual' }, createAttemptEvaluation(atMs))).toEqual(s.data);
	expect(s.reads()).toBe(1);
});
test.each(['YOUR_ACCOUNT_SUSPENDED', 'MODERATOR_REQUIRED', 'PERMISSION_DENIED'])('checks %s before input or existence', async reason => {
	const s = setup();
	s.facts.user.isSuspended = reason === 'YOUR_ACCOUNT_SUSPENDED';
	s.facts.instance.rootUserId = reason === 'MODERATOR_REQUIRED' ? null : 'user';
	await expect(s.useCase.showRole(request({ userId: 'user', native: false, permissions: new Set(['write:admin:roles']) }), { roleId: '!' }, createAttemptEvaluation(atMs)))
		.rejects.toMatchObject({ reason });
	expect(s.reads()).toBe(0);
});
test('checks input before role existence', async () => {
	const s = setup();
	await expect(s.useCase.showRole(request(actor), {}, createAttemptEvaluation(atMs))).rejects.toMatchObject({ param: '#/required' });
	expect(s.reads()).toBe(0);
	await expect(s.useCase.showRole(request(actor), { roleId: 'missing' }, createAttemptEvaluation(atMs))).rejects.toBeInstanceOf(RoleNotFound);
});
