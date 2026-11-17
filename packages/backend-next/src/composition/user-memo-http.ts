/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createUserMemo } from '../modules/user-memo/public.js';
import { createUserMemoEndpoints } from '../http/user-memo-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createUserMemoStore } from '../platform/database/user-memo.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createUserMemoHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>, config: RuntimeConfig) {
	const ids = createIdCodec(config.id);
	const application = createUserMemo({ ...createUserMemoStore(resources.dataSource.manager), newId: () => ids.newId(Date.now()) });
	return createApiEndpoints({
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		endpoints: createUserMemoEndpoints(application), logger: resources.logger,
	});
}
