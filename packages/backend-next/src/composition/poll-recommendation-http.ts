/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPollRecommendationApi } from '../http/poll-recommendation-api.js';
import { createRecommendPolls } from '../modules/poll-recommendation/public.js';
import { createPollRecommendationReader } from '../platform/database/poll-recommendation.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createPollRecommendationHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const codec = createIdCodec(config.id);
	const recommendation = createRecommendPolls(createPollRecommendationReader(manager, resources.reactionsRedis,
		{ ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis));
	return createPollRecommendationApi({
		authenticate: createTokenAuthenticator(manager, resources.logger),
		recommendPolls: recommendation.recommendPolls,
		logger: resources.logger,
	});
}
