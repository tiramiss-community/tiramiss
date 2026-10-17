/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { evaluatePrivileges } from '../../../src/modules/role/privileges.js';
import { role } from './fixtures.js';

test.each([
	[null, null, [role({ isAdministrator: true })], false, false],
	['root', 'root', [], true, true],
	['user', null, [role({ isAdministrator: true })], true, true],
	['user', 'root', [role({ isModerator: true })], false, true],
	['user', 'root', [role()], false, false],
] as const)('privileges for %s and root %s', (userId, rootUserId, roles, isAdministrator, isModerator) => {
	expect(evaluatePrivileges(userId, rootUserId, roles)).toEqual({ isAdministrator, isModerator });
});
