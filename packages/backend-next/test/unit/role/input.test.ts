/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { parseRoleInput } from '../../../src/modules/role/input.js';

test('accepts arbitrary JSON and unknown fields without normalizing or merging', () => {
	const input = { roleId: 'x', name: '', policies: { unknown: null }, condFormula: { invalid: true }, color: null, ignored: true };
	expect(parseRoleInput(input, 'update')).toEqual({ roleId: 'x', patch: { name: '', policies: { unknown: null }, condFormula: { invalid: true }, color: null } });
});

test.each([
	[{}, '#/required', 'must have required property \'roleId\''],
	[{ roleId: null }, '#/properties/roleId/type', 'must be string'],
	[{ roleId: '!' }, '#/properties/roleId/format', 'must match format "misskey:id"'],
	[{ roleId: 'x', target: 'other' }, '#/properties/target/enum', 'must be equal to one of the allowed values'],
	[{ roleId: 'x', name: null }, '#/properties/name/type', 'must be string'],
	[{ roleId: 'x', policies: [] }, '#/properties/policies/type', 'must be object'],
])('preserves first validation error for %j', (input, param, reason) => {
	expect(() => parseRoleInput(input, 'update')).toThrow(expect.objectContaining({ param, reason }));
});
