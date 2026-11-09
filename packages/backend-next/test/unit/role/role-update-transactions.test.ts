/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import type { RoleDefinition, RoleUpdateScope } from '../../../src/modules/role/public.js';
import { createRoleUpdateTransactions } from '../../../src/platform/database/role-update.js';
import { atMs, role } from './fixtures.js';

test.each(
	['commit', 'rollback'].flatMap(outcome => (['getForUpdate', 'savePatch', 'authorization', 'audit'] as const).map(operation => ({ outcome, operation }))),
)('rejects escaped $operation before adapter access after $outcome', async ({ outcome, operation }) => {
	const access = vi.fn(() => {
		throw new Error('unexpected database access');
	});
	const repository = { findOne: access, findOneBy: access, find: access, findBy: access, createQueryBuilder: access, insert: access };
	const getRepository = vi.fn(() => repository);
	const manager = { getRepository, query: access } as unknown as EntityManager;
	const source = { transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager) } as unknown as DataSource;
	const ids = { createdAtFromId: vi.fn(() => atMs), newAuditId: vi.fn(() => 'audit') };
	const transactions = createRoleUpdateTransactions(source, ids);
	const before: RoleDefinition = {
		...role(), name: 'before', description: 'keep', color: '#fff', iconUrl: 'icon',
		updatedAtMs: atMs - 1000, lastUsedAtMs: atMs - 2000,
		isPublic: false, isExplorable: false, asBadge: false,
		preserveAssignmentOnMoveAccount: false, canEditMembersByModerator: false, displayOrder: 0,
	};
	const record = { actorId: 'user', roleId: before.id, before, after: { ...before, name: 'after' }, occurredAtMs: atMs };
	const failure = new Error('business rejected');
	let scope!: RoleUpdateScope;
	const pending = transactions.run(async tx => {
		scope = tx;
		if (outcome === 'rollback') {
			throw failure;
		}
	});
	if (outcome === 'rollback') {
		await expect(pending).rejects.toBe(failure);
	} else {
		await pending;
	}
	getRepository.mockClear();
	const operations = {
		getForUpdate: () => scope.roles.getForUpdate(before.id),
		savePatch: () => scope.roles.savePatch(before.id, {}, atMs),
		authorization: () => scope.authorizationFacts.read('user'),
		audit: () => scope.auditLogs.appendRoleUpdate(record),
	};
	await expect(operations[operation]()).rejects.toThrow('The transaction has ended');
	expect(getRepository).not.toHaveBeenCalled();
	expect(access).not.toHaveBeenCalled();
	expect(ids.createdAtFromId).not.toHaveBeenCalled();
	expect(ids.newAuditId).not.toHaveBeenCalled();
});
