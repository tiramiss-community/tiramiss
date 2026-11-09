/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRoleApplication } from './role.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createRoleEndpoints } from '../http/role-api.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createRoleHttpApp(
	resources: Pick<RuntimeResources, 'dataSource' | 'logger'> & {
		roleMaterials: Pick<RuntimeResources['roleMaterials'], 'changes'>;
	},
	config: Pick<RuntimeConfig, 'id'>,
) {
	const codec = createIdCodec(config.id);
	const application = createRoleApplication({
		dataSource: resources.dataSource,
		ids: { createdAtFromId: codec.createdAtFromId, newAuditId: codec.newId },
		clock: Date.now,
		changes: resources.roleMaterials.changes,
	});
	return createApiEndpoints({
		endpoints: createRoleEndpoints(application),
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		logger: resources.logger,
	});
}
