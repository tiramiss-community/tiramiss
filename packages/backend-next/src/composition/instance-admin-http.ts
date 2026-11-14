/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import type { RuntimeResources } from './create-runtime.js';

export function createInstanceAdminHttp(resources: RuntimeResources) {
	const access = { requireCredential: true, requireModerator: true, kind: 'write:admin:federation' };
	return createApiEndpoints({
		endpoints: [
			{ name: 'admin/federation/update-instance', access, handle: resources.instanceAdministration.updateInstance },
			{ name: 'admin/federation/refresh-remote-instance-metadata', access, handle: resources.instanceAdministration.refreshMetadata },
		],
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		logger: resources.logger,
	});
}
