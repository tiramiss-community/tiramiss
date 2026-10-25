/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { assertPhysicalCapacity } from './work-capacity/gate.js';
import { MiRole } from 'backend-upstream/entities';
import type { DataSource } from 'typeorm';
import type { TransactionRunner } from '../../application/transaction.js';
import type { RoleUpdateScope } from '../../modules/role/public.js';
import { RoleNotFound } from '../../modules/role/public.js';
import { createTransactionRunner } from './transaction-runner.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import { roleDefinition, rolePatchColumns } from './role-mapping.js';
import { appendRoleUpdateAudit } from './role-update-audit.js';

export function createRoleUpdateTransactions(source: DataSource, ids: {
	createdAtFromId(id: string): number;
	newAuditId(occurredAtMs: number): string;
}): TransactionRunner<RoleUpdateScope> {
	const transactions = createTransactionRunner(source, manager => manager);
	return {
		run: work => transactions.run(async manager => {
			let active = true;
			const assertActive = () => {
				if (!active) {
					throw new Error('The role update transaction has ended');
				}
			};
			const roles = manager.getRepository(MiRole);
			try {
				return await work({
					roles: {
						getForUpdate: async roleId => {
							assertActive();
							const row = await roles.findOne({ where: { id: roleId }, lock: { mode: 'pessimistic_write' } });
							return row === null ? null : roleDefinition(row);
						},
						savePatch: async (roleId, patch, updatedAtMs) => {
							assertActive();
							await assertPhysicalCapacity(manager);
							const saved = await roles.createQueryBuilder().update()
								.set({ ...rolePatchColumns(patch), updatedAt: new Date(updatedAtMs) })
								.where('id = :roleId', { roleId }).returning('*').execute();
							if (saved.affected !== 1) {
								throw new RoleNotFound();
							}
							return roleDefinition(saved.raw[0] as MiRole);
						},
					},
					authorizationFacts: { read: async actorId => {
						assertActive();
						return readRoleAuthorizationFacts(manager, actorId, ids.createdAtFromId);
					} },
					auditLogs: { appendRoleUpdate: async record => {
						assertActive();
						await appendRoleUpdateAudit(manager, record, ids.newAuditId);
					} },
				});
			} finally {
				active = false;
			}
		}),
	};
}
