/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPageReader } from '../modules/page/public.js';
import { createPageStore } from '../platform/database/pages.js';
import { createPageEndpoints } from '../http/pages-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
export function createPagesHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>, config: RuntimeConfig) {
	const ids = createIdCodec(config.id);
	const reader = createPageReader({
		...createPageStore(resources.dataSource.manager, { url: config.url, ...config.noteMedia, createdAtFromId: ids.createdAtFromId }),
		writeFailed: (error, pageId) => {
			resources.logger.error('page.content-write-failed', { error, pageId });
		},
	});
	const app = createApiEndpoints({ authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), endpoints: createPageEndpoints(reader), logger: resources.logger });
	return { app, idle: reader.idle };
}
