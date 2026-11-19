/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createDriveListUsage } from '../modules/drive/list-usage.js';
import { createDriveListEndpoints } from '../http/drive-list-api.js';
import { createDriveListStore } from '../platform/database/drive-list-usage.js';
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
	const lists = createDriveListUsage(createDriveListStore(resources.dataSource.manager, { url: config.url, ...config.noteMedia, createdAtFromId: ids.createdAtFromId }, ids.newId));
	return createApiEndpoints({ authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), endpoints: [...createDriveFileEndpoints(application), ...createDriveListEndpoints(lists)], logger: resources.logger });
}
