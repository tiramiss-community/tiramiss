/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DEFAULT_POLICIES, type RolePolicies } from '../../../src/modules/role/policy-defaults.js';
import { evaluatePolicies } from '../../../src/modules/role/policies.js';
import { policy, role } from './fixtures.js';

const baseline: Record<string, unknown> = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/role/policy-defaults.json', import.meta.url), 'utf8'));
const input = { userId: 'user', roles: [], basePolicies: {}, uploadLimitBytes: 20 * 1024 * 1024 };

test('all code defaults and anonymous output match the shared upstream baseline', () => {
	expect(DEFAULT_POLICIES).toEqual(baseline);
	expect(evaluatePolicies({ ...input, userId: null })).toEqual(baseline);
});

test('anonymous keeps base JSON including unknown keys, without upload cap or trim', () => {
	const basePolicies = { driveCapacityMb: 55, uploadableFileTypes: [' image/* ', ''], unknown: { keep: true } };
	expect(evaluatePolicies({ ...input, userId: null, basePolicies })).toEqual({ ...baseline, ...basePolicies });
	expect(evaluatePolicies(input).maxFileSizeMb).toBe(20);
});

test.each([
	['priority two', [policy(999, 1), policy(200, 2)], 200],
	['priority one', [policy(999), policy(200, 1)], 200],
	['same priority maximum', [policy(100, 2), policy(200, 2)], 200],
	['useDefault instance value', [policy(999, 2, true), policy(200, 1)], 55],
	['priority three is not highest', [policy(999, 3), policy(200, 1)], 200],
	['missing entry participates', [undefined, policy(20)], 55],
	['null entry participates', [null, policy(20)], 55],
	['override does not always include base', [policy(20)], 20],
] as const)('%s', (_name, values, expected) => {
	const roles = values.map(value => role({ policies: { driveCapacityMb: value } }));
	expect(evaluatePolicies({ ...input, roles, basePolicies: { driveCapacityMb: 55 } }).driveCapacityMb).toBe(expected);
});

test('all boolean and numeric keys aggregate independently', () => {
	for (const key of Object.keys(DEFAULT_POLICIES) as (keyof RolePolicies)[]) {
		const value = baseline[key];
		if (typeof value === 'boolean') {
			const roles = [role({ policies: { [key]: policy(false) } }), role({ policies: { [key]: policy(true) } })];
			expect(evaluatePolicies({ ...input, roles })[key]).toBe(true);
			expect(evaluatePolicies({ ...input, roles: [roles[0]] })[key]).toBe(false);
		} else if (typeof value === 'number') {
			const roles = [role({ policies: { [key]: policy(0.5) } }), role({ policies: { [key]: policy(2) } })];
			expect(evaluatePolicies({ ...input, roles })[key]).toBe(2);
		}
	}
});

test.each([
	[['unavailable', 'readonly'], 'readonly'],
	[['readonly', 'available'], 'available'],
	[['unknown'], 'unavailable'],
] as const)('chat availability %j -> %s', (values, expected) => {
	const roles = values.map(value => role({ policies: { chatAvailability: policy(value) } }));
	expect(evaluatePolicies({ ...input, roles }).chatAvailability).toBe(expected);
});

test('file types form a trimmed union in first occurrence order', () => {
	const roles = [
		role({ policies: { uploadableFileTypes: policy([' image/* ', '', 'image/*']) } }),
		role({ policies: { uploadableFileTypes: policy(['audio/*', 'image/png']) } }),
	];
	expect(evaluatePolicies({ ...input, roles }).uploadableFileTypes).toEqual(['image/*', 'audio/*', 'image/png']);
});

test('file size caps at floored bytes and root has ordinary policies', () => {
	expect(evaluatePolicies({ ...input, uploadLimitBytes: 21 * 1024 * 1024 - 1 }).maxFileSizeMb).toBe(20);
	expect(evaluatePolicies({ ...input, userId: 'root' }).canInvite).toBe(false);
});

test('stored malformed scalar values retain upstream coercion and strict true', () => {
	const roles = [role({ policies: { driveCapacityMb: policy('7'), canInvite: policy(1), chatAvailability: policy(null) } })];
	expect(evaluatePolicies({ ...input, roles })).toMatchObject({ driveCapacityMb: 7, canInvite: false, chatAvailability: 'unavailable' });
	expect(evaluatePolicies({ ...input, roles: [role({ policies: { driveCapacityMb: {} } })] }).driveCapacityMb).toBeNaN();
	expect(() => evaluatePolicies({ ...input, roles: [role({ policies: null })] })).toThrow(TypeError);
	expect(() => evaluatePolicies({ ...input, roles: [role({ policies: { uploadableFileTypes: policy([1]) } })] })).toThrow(TypeError);
});

test('evaluation does not mutate or expose input JSON', () => {
	const basePolicies = { uploadableFileTypes: [' image/* '] };
	const snapshot = structuredClone(basePolicies);
	const result = evaluatePolicies({ ...input, userId: null, basePolicies });
	(result.uploadableFileTypes as string[]).push('audio/*');
	expect(basePolicies).toEqual(snapshot);
});
