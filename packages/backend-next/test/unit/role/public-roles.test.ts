/*
	* SPDX-FileCopyrightText: syuilo and misskey-project
	* SPDX-License-Identifier: AGPL-3.0-only
	*/
import { expect, test } from 'vitest';
import { RoleNotFound } from '../../../src/modules/role/errors.js';
import { createPublicRoles, userRoleMaterials } from '../../../src/modules/role/public-roles.js';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import { createAttemptEvaluation } from '../../../src/modules/role/evaluation.js';
import { atMs, assignment, role, user } from './fixtures.js';
import type { RoleDefinition } from '../../../src/modules/role/public.js';

const definition = (patch: Partial<RoleDefinition> = {}): RoleDefinition => ({ ...role(), name: 'role', description: '', color: null, iconUrl: null, updatedAtMs: atMs, lastUsedAtMs: atMs, isPublic: true, isExplorable: true, asBadge: false, preserveAssignmentOnMoveAccount: false, canEditMembersByModerator: false, displayOrder: 0, ...patch });

test('public show validates input, hides private and missing roles, and needs no authorization facts', async () => {
	const data = { role: definition(), createdAtMs: atMs, assignedCount: 2 };
	const app = createPublicRoles({ authorizationFacts: { read: async () => {
		throw new Error('unexpected facts'); 
	} }, roles: { readPublic: async id => id === 'manual' ? data : null, listPublic: async () => [data] } });
	const access = createAccessRequest({}, null);
	expect(await app.showPublicRole(access, { roleId: 'manual' }, createAttemptEvaluation(atMs))).toEqual(data);
	await expect(app.showPublicRole(access, {}, createAttemptEvaluation(atMs))).rejects.toMatchObject({ param: '#/required' });
	await expect(app.showPublicRole(access, { roleId: 'private' }, createAttemptEvaluation(atMs))).rejects.toBeInstanceOf(RoleNotFound);
});

test('list authorizes suspension and scope before reading public roles', async () => {
	let reads = 0;
	const facts = { user: user(), instance: { rootUserId: null, basePolicies: {} }, roles: [], assignments: [] };
	const app = createPublicRoles({ authorizationFacts: { read: async () => facts }, roles: { readPublic: async () => null, listPublic: async () => {
		reads++; return []; 
	} } });
	const access = (permissions: string[]) => createAccessRequest({ requireCredential: true, kind: 'read:account' }, { userId: 'user', native: false, permissions: new Set(permissions) });
	await expect(app.listPublicRoles(access([]), {}, createAttemptEvaluation(atMs))).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' });
	facts.user.isSuspended = true;
	await expect(app.listPublicRoles(access(['read:account']), {}, createAttemptEvaluation(atMs))).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	expect(reads).toBe(0);
	facts.user.isSuspended = false;
	expect(await app.listPublicRoles(access(['read:account']), { ignored: true }, createAttemptEvaluation(atMs))).toEqual([]);
	expect(reads).toBe(1);
	await expect(app.listPublicRoles(access(['read:account']), [], createAttemptEvaluation(atMs))).rejects.toMatchObject({ param: '#/type' });
	expect(reads).toBe(1);
});

test('UserDetailed materials include conditional roles and valid assignments, filter private, and sort stably descending', () => {
	const roles = [definition(), definition({ id: 'private', isPublic: false, displayOrder: 100 }), definition({ id: 'conditional', target: 'conditional', condFormula: { type: 'isLocal' }, displayOrder: 4 }), definition({ id: 'expired', displayOrder: 10 }), definition({ id: 'equal', displayOrder: 4 })];
	const assignments = [assignment(), assignment({ roleId: 'private' }), assignment({ roleId: 'expired', expiresAtMs: atMs }), assignment({ roleId: 'equal', expiresAtMs: atMs + 1 })];
	const before = structuredClone(roles);
	expect(userRoleMaterials(roles, assignments, user(), atMs).map(row => row.id)).toEqual(['equal', 'conditional', 'manual']);
	expect(roles).toEqual(before);
	expect(Object.keys(userRoleMaterials(roles, assignments, user(), atMs)[0])).toEqual(['id', 'name', 'color', 'iconUrl', 'description', 'isModerator', 'isAdministrator', 'displayOrder']);
});
