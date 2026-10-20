/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRoleApi } from '../http/role-api.js';
import { createShowRole, createUpdateRole } from '../modules/role/public.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { createRoleShowReader } from '../platform/database/role-show.js';
import { createRoleUpdateTransactions } from '../platform/database/role-update.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createRoleHttpApp(resources: RuntimeResources, config: RuntimeConfig) {
	const codec = createIdCodec(config.id);
	const manager = resources.dataSource.manager;
	const show = createShowRole({
		authorizationFacts: { read: id => readRoleAuthorizationFacts(manager, id, codec.createdAtFromId) },
		roles: createRoleShowReader(manager, codec.createdAtFromId),
	});
	const update = createUpdateRole({
		transactions: createRoleUpdateTransactions(resources.dataSource, { createdAtFromId: codec.createdAtFromId, newAuditId: codec.newId }),
		changes: resources.roleMaterials.changes, clock: Date.now,
	});
	return createRoleApi({ authenticate: createTokenAuthenticator(manager, resources.logger),
																								showRole: show.showRole, updateRole: update.updateRole, logger: resources.logger });
}
