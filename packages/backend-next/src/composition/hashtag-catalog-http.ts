/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHashtagCatalog } from '../modules/hashtag/catalog.js';
import { createHashtagCatalogEndpoints } from '../http/hashtag-catalog-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createHashtagCatalogReader } from '../platform/database/hashtag-catalog.js';
import type { RuntimeResources } from './create-runtime.js';

export function createHashtagCatalogHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>) {
	const application = createHashtagCatalog(createHashtagCatalogReader(resources.dataSource.manager));
	return createApiEndpoints({
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		endpoints: createHashtagCatalogEndpoints(application), logger: resources.logger,
	});
}
