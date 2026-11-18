/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createUpdateDefaultPolicies } from '../../../src/modules/role/update-default-policies.js';
import { createAccessRequest, InputInvalid } from '../../../src/modules/access/public.js';
const request = (permissions?: string[]) => createAccessRequest({ requireCredential: true, requireAdmin: true, kind: 'write:admin:roles' }, { userId: 'actor', native: permissions === undefined, permissions: new Set(permissions) });

function setup() {
	let policies: Record<string, unknown> = { canInvite: false, driveCapacityMb: 55 };
	const facts = { isSuspended: false, isAdministrator: true, isModerator: true };
	const dependencies = {
		authorizationFacts: vi.fn(async () => facts),
		readPolicies: vi.fn(async () => structuredClone(policies)),
		replacePolicies: vi.fn(async (next: Record<string, unknown>) => {
			policies = structuredClone(next);
		}),
		startPolicyNotification: vi.fn(), startAudit: vi.fn(), clock: () => 123,
	};
	return { facts, dependencies, application: createUpdateDefaultPolicies(dependencies), policies: () => policies };
}

test('replaces arbitrary JSON policies and starts audit with raw before/after only after saving', async () => {
	const s = setup();
	const policies = { canInvite: 'yes', driveCapacityMb: '7', unknown: { nested: [null] } };
	await s.application.updateDefaultPolicies(request(), { policies, ignored: true });
	expect(s.policies()).toEqual(policies);
	expect(s.dependencies.startPolicyNotification).toHaveBeenCalledWith(policies);
	expect(s.dependencies.startAudit).toHaveBeenCalledWith({ actorId: 'actor', type: 'updateServerSettings', info: { before: { canInvite: false, driveCapacityMb: 55 }, after: policies }, occurredAtMs: 123 });
	await s.application.updateDefaultPolicies(request(), { policies: {} });
	expect(s.policies()).toEqual({});
});
test.each([undefined, null, [], 'bad', 1])('rejects non-object policies %j without saving', async (policies) => {
	const s = setup();
	await expect(s.application.updateDefaultPolicies(request(), { policies })).rejects.toBeInstanceOf(InputInvalid);
	expect(s.dependencies.replacePolicies).not.toHaveBeenCalled();
});
test('checks current qualifications and scope before malformed input', async () => {
	const s = setup();
	s.facts.isAdministrator = false;
	await expect(s.application.updateDefaultPolicies(request(), {})).rejects.toMatchObject({ reason: 'ADMINISTRATOR_REQUIRED' });
	s.facts.isAdministrator = true;
	await expect(s.application.updateDefaultPolicies(request([]), {})).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' });
	expect(s.dependencies.readPolicies).not.toHaveBeenCalled();
});
test('storage failure preserves existing policies without starting effects', async () => {
	const s = setup();
	s.dependencies.replacePolicies.mockRejectedValueOnce(new Error('storage failure'));
	await expect(s.application.updateDefaultPolicies(request(), { policies: {} })).rejects.toThrow('storage failure');
	expect(s.policies()).toEqual({ canInvite: false, driveCapacityMb: 55 });
	expect(s.dependencies.startAudit).not.toHaveBeenCalled();
	expect(s.dependencies.startPolicyNotification).not.toHaveBeenCalled();
});
