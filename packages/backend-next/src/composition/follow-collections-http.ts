/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createActivityPubFollowCollectionsApi } from '../http/activitypub-follow-collections-api.js';
import { readFollowCollection } from '../modules/federation/public.js';
import { createFollowCollectionReader } from '../platform/database/local-follow-collections.js';
import { readMeta } from '../platform/database/meta.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createFollowCollectionsHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const reader = createFollowCollectionReader(manager);
	return createActivityPubFollowCollectionsApi({
		logger: resources.logger,
		federationEnabled: async () => (await readMeta(manager)).federation !== 'none',
		readCollection: (id, direction, page, cursor) => readFollowCollection(id, direction, page, cursor, reader, config.url),
	});
}
