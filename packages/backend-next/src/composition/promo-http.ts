/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPromo } from '../modules/promo/public.js';
import { roleAccessFacts } from '../modules/role/public.js';
import { createPromoEndpoints } from '../http/promo-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createPromoStore } from '../platform/database/promo.js';
import { readRoleAuthorizationFacts } from '../platform/database/role-authorization-facts.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createPromoHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>, config: Pick<RuntimeConfig, 'id'>) {
	const { manager } = resources.dataSource;
	const ids = createIdCodec(config.id);
	const application = createPromo({
		...createPromoStore(manager),
		readActor: async userId => roleAccessFacts(userId, await readRoleAuthorizationFacts(manager, userId, ids.createdAtFromId), Date.now()),
	});
	return createApiEndpoints({
		authenticate: createTokenAuthenticator(manager, resources.logger),
		endpoints: createPromoEndpoints(application), logger: resources.logger,
	});
}
