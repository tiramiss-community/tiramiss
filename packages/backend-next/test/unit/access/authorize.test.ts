/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { AccessDenied, authorizeAccess, compileInput, createAccessRequest, InputInvalid, requireCredential } from '../../../src/modules/access/public.js';
import type { AccessCredential, AccessFacts, AccessRequirement } from '../../../src/modules/access/public.js';

const native: AccessCredential = { userId: 'u', native: true };
const app = (...permissions: string[]): AccessCredential => ({ userId: 'u', native: false, permissions: new Set(permissions) });
const ordinary: AccessFacts = { isSuspended: false, isModerator: false, isAdministrator: false };
const administrator: AccessFacts = { isSuspended: false, isModerator: true, isAdministrator: true };

function reason(requirement: AccessRequirement, credential: AccessCredential | null, facts: AccessFacts): string | undefined {
	try {
		createAccessRequest(requirement, credential).authorize(facts);
		return undefined;
	} catch (error) {
		if (error instanceof AccessDenied) {
			return error.reason;
		}
		throw error;
	}
}

describe('authorizeAccess', () => {
	const admin = { requireAdmin: true, kind: 'write:admin:roles' };

	test('rejects in upstream order: credential, suspension, role, then scope', () => {
		const worst = { isSuspended: true, isModerator: false, isAdministrator: false };
		expect(reason(admin, null, worst)).toBe('CREDENTIAL_REQUIRED');
		expect(reason(admin, app(), worst)).toBe('YOUR_ACCOUNT_SUSPENDED');
		expect(reason(admin, app(), ordinary)).toBe('ADMINISTRATOR_REQUIRED');
		expect(reason(admin, app(), administrator)).toBe('PERMISSION_DENIED');
		expect(reason(admin, app('write:admin:roles'), administrator)).toBeUndefined();
	});

	test('a moderator requirement accepts administrators and reports the moderator reason', () => {
		const moderator = { requireModerator: true, kind: 'read:admin:queue' };
		expect(reason(moderator, native, ordinary)).toBe('MODERATOR_REQUIRED');
		expect(reason(moderator, native, { ...ordinary, isModerator: true })).toBeUndefined();
		expect(reason(moderator, native, administrator)).toBeUndefined();
	});

	test('a native credential has every permission', () => {
		expect(reason(admin, native, administrator)).toBeUndefined();
		expect(reason({ requireCredential: true }, native, ordinary)).toBeUndefined();
	});

	test('a credentialed endpoint without kind denies every non-native credential', () => {
		expect(reason({ requireCredential: true }, app('read:account', 'write:notes'), ordinary)).toBe('PERMISSION_DENIED');
	});

	test('an endpoint without a credential requirement does not check suspension', () => {
		expect(reason({}, app(), { ...ordinary, isSuspended: true })).toBeUndefined();
	});

	test('a token without the endpoint kind is denied even without a credential requirement', () => {
		expect(reason({ kind: 'read:account' }, app(), ordinary)).toBe('PERMISSION_DENIED');
		expect(authorizeAccess({ kind: 'read:account' }, native, ordinary)).toBe(native);
	});

	test('requireCredential returns the credential or rejects a guest', () => {
		expect(requireCredential(native)).toBe(native);
		expect(() => requireCredential(null)).toThrow(AccessDenied);
	});
});

describe('createAccessRequest', () => {
	test('reports whether authorization was performed', () => {
		const request = createAccessRequest({ requireModerator: true, kind: 'read:admin:queue' }, native);
		expect(request.authorized).toBe(false);
		expect(request.authorize({ ...ordinary, isModerator: true })).toBe(native);
		expect(request.authorized).toBe(true);
	});

	test('an endpoint without a credential requirement is authorized on creation, guests included', () => {
		expect(createAccessRequest({}, null).authorized).toBe(true);
		expect(createAccessRequest({ kind: 'read:account' }, app('read:account')).authorized).toBe(true);
		expect(() => createAccessRequest({ kind: 'read:account' }, app())).toThrow(AccessDenied);
	});

	test('a rejected authorization is not reported as performed', () => {
		const request = createAccessRequest({ requireModerator: true }, native);
		expect(() => request.authorize(ordinary)).toThrow(AccessDenied);
		expect(request.authorized).toBe(false);
	});
});

describe('compileInput', () => {
	const read = compileInput<{ roleId: string; limit: number }>({
		type: 'object',
		properties: { roleId: { type: 'string', format: 'misskey:id' }, limit: { type: 'integer', default: 10 } },
		required: ['roleId'],
	});

	test('applies defaults and returns the same input', () => {
		const input = { roleId: 'abc' };
		expect(read(input)).toEqual({ roleId: 'abc', limit: 10 });
		expect(read(input)).toBe(input);
	});

	test.each([
		[undefined, '#/type', 'must be object'],
		[{}, '#/required', 'must have required property \'roleId\''],
		[{ roleId: '!' }, '#/properties/roleId/format', 'must match format "misskey:id"'],
		[{ roleId: 1 }, '#/properties/roleId/type', 'must be string'],
	])('reports the first Ajv error as param and reason for %j', (input, param, reasonText) => {
		let error: unknown;
		try {
			read(input);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(InputInvalid);
		expect(error).toMatchObject({ param, reason: reasonText });
	});
});
