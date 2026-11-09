/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createShowRole, createUpdateRole } from '../modules/role/public.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { createRoleShowReader } from '../platform/database/role-show.js';
import { createRoleUpdateTransactions } from '../platform/database/role-update.js';
import type { DataSource } from 'typeorm';
import type { RoleChanges } from '../modules/role/public.js';

export interface RoleApplicationDependencies {
	dataSource: DataSource;
	ids: {
		createdAtFromId(id: string): number;
		newAuditId(atMs: number): string;
	};
	clock: () => number;
	changes: RoleChanges;
}

export type RoleApplication = ReturnType<typeof createShowRole> & ReturnType<typeof createUpdateRole>;

export function createRoleApplication(parts: RoleApplicationDependencies): RoleApplication {
	const manager = parts.dataSource.manager;
	const show = createShowRole({
		authorizationFacts: { read: id => readRoleAuthorizationFacts(manager, id, parts.ids.createdAtFromId) },
		roles: createRoleShowReader(manager, parts.ids.createdAtFromId),
	});
	const update = createUpdateRole({
		transactions: createRoleUpdateTransactions(parts.dataSource, parts.ids),
		clock: parts.clock,
		changes: parts.changes,
	});
	return { showRole: show.showRole, updateRole: update.updateRole };
}
