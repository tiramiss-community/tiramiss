/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createUserRelation } from '../modules/user-relation/public.js';
import { createUserRelationEndpoints } from '../http/user-relation-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createUserRelationStore } from '../platform/database/user-relation.js';
import type { RuntimeResources } from './create-runtime.js';

export function createUserRelationHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>) {
	return createApiEndpoints({
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		endpoints: createUserRelationEndpoints(createUserRelation(createUserRelationStore(resources.dataSource.manager))), logger: resources.logger,
	});
}
