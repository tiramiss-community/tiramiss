/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createDriveFiles } from '../modules/drive/files.js';
import { createDriveFileEndpoints } from '../http/drive-files-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createDriveFileStore } from '../platform/database/drive-files.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
export function createDriveFilesHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>, config: RuntimeConfig) {
	const ids = createIdCodec(config.id);
	const application = createDriveFiles(createDriveFileStore(resources.dataSource.manager, { url: config.url, ...config.noteMedia, createdAtFromId: ids.createdAtFromId }));
	return createApiEndpoints({ authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), endpoints: createDriveFileEndpoints(application), logger: resources.logger });
}
