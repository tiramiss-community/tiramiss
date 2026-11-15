/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createDriveFolders, DriveFolderError } from '../modules/drive/folders.js';
import { createDriveFolderEndpoints } from '../http/drive-folders-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createDriveFolderStore } from '../platform/database/drive-folders.js';
import { createApiRateLimiter } from '../platform/api-rate-limit.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createDriveFolderPublisher } from '../platform/drive-folder-publisher.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
export function createDriveFoldersHttp(resources: Pick<RuntimeResources, 'dataSource' | 'redis' | 'postingStream' | 'logger'>, config: RuntimeConfig) {
	const ids = createIdCodec(config.id);
	const limit = createApiRateLimiter(resources.redis);
	const publisher = createDriveFolderPublisher((userId, type, body) => resources.postingStream.drive(userId, type, body), resources.logger);
	const application = createDriveFolders({
		...createDriveFolderStore(resources.dataSource.manager, ids.createdAtFromId),
		newId: () => ids.newId(Date.now()), createdAtFromId: ids.createdAtFromId,
		publish: publisher.publish,
		async limit(userId, factor) {
			const exceeded = await limit({ key: 'drive/folders/create', duration: 3600000, max: 10 }, userId, factor);
			if (exceeded) {
				throw new DriveFolderError('RATE_LIMIT_EXCEEDED', 'd5826d14-3982-4d2e-8011-b9e9f02499ef', 'Rate limit exceeded. Please try again later.', exceeded);
			}
		},
	});
	return { app: createApiEndpoints({ authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), endpoints: createDriveFolderEndpoints(application), logger: resources.logger }), idle: publisher.idle };
}
