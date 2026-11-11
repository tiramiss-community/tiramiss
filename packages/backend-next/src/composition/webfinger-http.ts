/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createWebfingerApi } from '../http/webfinger-api.js';
import { createLocalWebfingerReader } from '../platform/database/local-webfinger.js';
import { readMeta } from '../platform/database/meta.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createWebfingerHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>, config: Pick<RuntimeConfig, 'url'>) {
	return createWebfingerApi({
		selfUrl: config.url,
		logger: resources.logger,
		readUser: createLocalWebfingerReader(resources.dataSource.manager),
		federationEnabled: async () => (await readMeta(resources.dataSource.manager)).federation !== 'none',
	});
}
