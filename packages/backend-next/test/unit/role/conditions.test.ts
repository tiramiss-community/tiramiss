/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { evaluateCondition } from '../../../src/modules/role/condition.js';
import { selectApplicableRoles } from '../../../src/modules/role/applicable-roles.js';
import { assignment, atMs, role, user } from './fixtures.js';

test.each([
	[{ type: 'and', values: [] }, true], [{ type: 'or', values: [] }, false],
	[{ type: 'and', values: [{ type: 'isLocal' }, { type: 'isBot' }] }, true],
	[{ type: 'or', values: [{ type: 'isCat' }, { type: 'isLocked' }] }, true],
	[{ type: 'not', value: { type: 'isCat' } }, true],
	[{ type: 'isLocal' }, true], [{ type: 'isRemote' }, false],
	[{ type: 'isSuspended' }, false], [{ type: 'isLocked' }, true],
	[{ type: 'isBot' }, true], [{ type: 'isCat' }, false], [{ type: 'isExplorable' }, true],
	[{ type: 'createdLessThan', sec: 10 }, false], [{ type: 'createdMoreThan', sec: 10 }, false],
	[{ type: 'createdLessThan', sec: 11 }, true], [{ type: 'createdMoreThan', sec: 9 }, true],
	[{ type: 'followersLessThanOrEq', value: 10 }, true], [{ type: 'followersMoreThanOrEq', value: 10 }, true],
	[{ type: 'followingLessThanOrEq', value: 20 }, true], [{ type: 'followingMoreThanOrEq', value: 20 }, true],
	[{ type: 'notesLessThanOrEq', value: 30 }, true], [{ type: 'notesMoreThanOrEq', value: 30 }, true],
	[{ type: 'followersLessThanOrEq', value: 9 }, false], [{ type: 'followersMoreThanOrEq', value: 11 }, false],
	[{ type: 'followingLessThanOrEq', value: 19 }, false], [{ type: 'followingMoreThanOrEq', value: 21 }, false],
	[{ type: 'notesLessThanOrEq', value: 29 }, false], [{ type: 'notesMoreThanOrEq', value: 31 }, false],
	[{ type: 'roleAssignedTo', roleId: 'manual' }, true],
	[{ type: 'roleAssignedTo', roleId: 'conditional' }, false],
	[{ type: 'unknown' }, false], [{ type: 'and' }, false], [null, false],
	[{ type: 'not', value: null }, true],
] as const)('condition %j -> %j', (formula, expected) => {
	expect(evaluateCondition(formula, user(), [role()], atMs)).toBe(expected);
});

test('remote and boolean attributes use the supplied user', () => {
	const facts = user({ host: 'remote.test', isSuspended: true, isLocked: false, isBot: false, isCat: true, isExplorable: false });
	for (const type of ['isRemote', 'isSuspended', 'isCat']) {
		expect(evaluateCondition({ type }, facts, [], atMs)).toBe(true);
	}
	for (const type of ['isLocal', 'isLocked', 'isBot', 'isExplorable']) {
		expect(evaluateCondition({ type }, facts, [], atMs)).toBe(false);
	}
});

test('expires strictly at the boundary without deleting assignments or crossing users', () => {
	const roles = ['forever', 'past', 'equal', 'future', 'other'].map(id => role({ id }));
	const assignments = [null, atMs - 1, atMs, atMs + 1].map((expiresAtMs, index) => assignment({ roleId: roles[index].id, expiresAtMs }));
	assignments.push(assignment({ roleId: 'other', userId: 'other' }));
	const original = structuredClone(assignments);
	expect(selectApplicableRoles(roles, assignments, user(), atMs).map(r => r.id)).toEqual(['forever', 'future']);
	expect(assignments).toEqual(original);
});

test('conditional matches do not cascade into roleAssignedTo', () => {
	const roles = [
		role(),
		role({ id: 'conditional', target: 'conditional', condFormula: { type: 'isLocal' } }),
		role({ id: 'cascade', target: 'conditional', condFormula: { type: 'roleAssignedTo', roleId: 'conditional' } }),
	];
	expect(selectApplicableRoles(roles, [assignment()], user(), atMs).map(r => r.id)).toEqual(['manual', 'conditional']);
});

test('an existing assignment to a conditional role participates even when its condition is false', () => {
	const roles = [
		role({ id: 'conditional', target: 'conditional', condFormula: { type: 'isCat' } }),
		role({ id: 'dependent', target: 'conditional', condFormula: { type: 'roleAssignedTo', roleId: 'conditional' } }),
	];
	expect(selectApplicableRoles(roles, [assignment({ roleId: 'conditional' })], user(), atMs).map(r => r.id)).toEqual(['conditional', 'dependent']);
});
