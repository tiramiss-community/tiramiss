/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RoleService, DEFAULT_POLICIES } from '@/core/RoleService.js';

const now = Date.parse('2026-10-14T12:00:00.000Z');
const policy = (value: unknown, priority = 0, useDefault = false) => ({ value, priority, useDefault });
const role = (policies: Record<string, unknown>) => ({ policies });

async function policies(roles: unknown[], base = {}, userId: string | null = 'user', rootUserId: string | null = null) {
	return RoleService.prototype.getUserPolicies.call({
		meta: { policies: base, rootUserId }, config: { maxFileSize: 20 * 1024 * 1024 }, getUserRoles: async () => roles,
	} as never, userId);
}

describe('pinned upstream Role evaluation contract', () => {
	test('all upstream default policy values match the recorded baseline', () => {
		const baseline = JSON.parse(readFileSync(new URL('./role-policy-defaults.json', import.meta.url), 'utf8'));
		expect(DEFAULT_POLICIES).toEqual(baseline);
	});
	test('anonymous uses merged defaults without upload-size cap', async () => {
		expect(await policies([], { driveCapacityMb: 55 }, null)).toEqual({ ...DEFAULT_POLICIES, driveCapacityMb: 55 });
		expect((await policies([])).maxFileSizeMb).toBe(20);
	});

	test.each([
		{ name: 'priority two', values: [policy(999, 1), policy(200, 2)], expected: 200 },
		{ name: 'priority one', values: [policy(999), policy(200, 1)], expected: 200 },
		{ name: 'equal priority maximum', values: [policy(100, 2), policy(200, 2)], expected: 200 },
		{ name: 'useDefault substitutes instance value', values: [policy(999, 2, true), policy(200, 1)], expected: 55 },
		{ name: 'out of range priority is not highest', values: [policy(999, 3), policy(200, 1)], expected: 200 },
		{ name: 'missing entry participates as base', values: [undefined, policy(20)], expected: 55 },
	])('$name', async ({ values, expected }) => {
		expect((await policies(values.map(value => role({ driveCapacityMb: value })), { driveCapacityMb: 55 })).driveCapacityMb).toBe(expected);
	});

	test('boolean OR, numeric maximum, ordered chat and trimmed file-type union', async () => {
		const result = await policies([
			role({ canInvite: policy(false), alwaysMarkNsfw: policy(false), rateLimitFactor: policy(0.5), chatAvailability: policy('readonly'), uploadableFileTypes: policy([' image/* ', '', 'image/*']) }),
			role({ canInvite: policy(true), alwaysMarkNsfw: policy(true), rateLimitFactor: policy(2), chatAvailability: policy('unavailable'), uploadableFileTypes: policy(['audio/*']) }),
		]);
		expect(result).toMatchObject({ canInvite: true, alwaysMarkNsfw: true, rateLimitFactor: 2, chatAvailability: 'readonly', uploadableFileTypes: ['image/*', 'audio/*'] });
	});

	test('assignment expiration is strict and does not delete records', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const assignments = [null, now - 1, now, now + 1].map((expiry, index) => ({ id: `${index}`, expiresAt: expiry === null ? null : new Date(expiry) }));
		const actual = await RoleService.prototype.getUserAssigns.call({ roleAssignmentByUserIdCache: { fetch: async () => assignments } } as never, 'user');
		expect(actual.map(value => value.id)).toEqual(['0', '3']);
		expect(assignments).toHaveLength(4);
	});

	const user = { id: 'user', host: null, isSuspended: false, isLocked: true, isBot: true, isCat: false, isExplorable: true, followersCount: 10, followingCount: 20, notesCount: 30 };
	const context = {
		userEntityService: { isLocalUser: (value: typeof user) => value.host === null, isRemoteUser: (value: typeof user) => value.host !== null },
		idService: { parse: () => ({ date: new Date(now - 10000) }) },
		evalCond: RoleService.prototype['evalCond'],
	};

	test.each([
		[{ type: 'and', values: [] }, true], [{ type: 'or', values: [] }, false],
		[{ type: 'not', value: { type: 'isCat' } }, true],
		[{ type: 'isLocal' }, true], [{ type: 'isRemote' }, false],
		[{ type: 'isSuspended' }, false], [{ type: 'isLocked' }, true], [{ type: 'isBot' }, true],
		[{ type: 'isCat' }, false], [{ type: 'isExplorable' }, true],
		[{ type: 'createdLessThan', sec: 10 }, false], [{ type: 'createdMoreThan', sec: 10 }, false],
		[{ type: 'createdLessThan', sec: 11 }, true], [{ type: 'createdMoreThan', sec: 9 }, true],
		[{ type: 'followersLessThanOrEq', value: 10 }, true], [{ type: 'followersMoreThanOrEq', value: 10 }, true],
		[{ type: 'followingLessThanOrEq', value: 20 }, true], [{ type: 'followingMoreThanOrEq', value: 20 }, true],
		[{ type: 'notesLessThanOrEq', value: 30 }, true], [{ type: 'notesMoreThanOrEq', value: 30 }, true],
		[{ type: 'roleAssignedTo', roleId: 'manual' }, true],
		[{ type: 'roleAssignedTo', roleId: 'conditional' }, false],
		[{ type: 'unknown' }, false], [{ type: 'and' }, false],
	])('condition %j -> %j', (formula, expected) => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		expect(context.evalCond.call(context as never, user as never, [{ id: 'manual' }] as never, formula as never)).toBe(expected);
	});

	test('conditional matches do not recursively satisfy roleAssignedTo', async () => {
		const roles = [
			{ id: 'manual', target: 'manual' },
			{ id: 'conditional', target: 'conditional', condFormula: { type: 'isLocal' } },
			{ id: 'cascade', target: 'conditional', condFormula: { type: 'roleAssignedTo', roleId: 'conditional' } },
		];
		const result = await RoleService.prototype.getUserRoles.call({
			...context, rolesCache: { fetch: async () => roles }, getUserAssigns: async () => [{ roleId: 'manual' }], cacheService: { findUserById: async () => user },
		} as never, 'user');
		expect(result.map(value => value.id)).toEqual(['manual', 'conditional']);
	});

	test('root and administrator imply moderator; root does not grant special policies', async () => {
		const root = { meta: { rootUserId: 'root' }, getUserRoles: async () => [] };
		expect(await RoleService.prototype.isAdministrator.call(root as never, { id: 'root' })).toBe(true);
		expect(await RoleService.prototype.isModerator.call(root as never, { id: 'root' })).toBe(true);
		expect(await RoleService.prototype.isAdministrator.call(root as never, null)).toBe(false);
		const admin = { meta: {}, getUserRoles: async () => [{ isAdministrator: true, isModerator: false }] };
		expect(await RoleService.prototype.isModerator.call(admin as never, { id: 'admin' })).toBe(true);
		expect((await policies([], {}, 'root', 'root')).canInvite).toBe(false);
	});
});
