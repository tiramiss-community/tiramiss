/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createWellKnownApi } from '../http/well-known-api.js';
import { createWebfingerApi } from '../http/webfinger-api.js';
import { createLocalWebfingerReader } from '../platform/database/local-webfinger.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createWebfingerHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger' | 'meta'>, config: Pick<RuntimeConfig, 'url'>) {
	const parts = {
		selfUrl: config.url,
		logger: resources.logger,
		federationEnabled: async () => (await resources.meta.fetch()).federation !== 'none',
	};
	return createWellKnownApi(parts).route('/', createWebfingerApi({
		...parts, readUser: createLocalWebfingerReader(resources.dataSource.manager),
	}));
}
