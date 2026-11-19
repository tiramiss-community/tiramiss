/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createNotePersonalState, NotePersonalStateError } from '../modules/note-personal-state/public.js';
import { createNotePersonalStateEndpoints } from '../http/note-personal-state-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createNotePersonalStateStore } from '../platform/database/note-personal-state.js';
import { createApiRateLimiter } from '../platform/api-rate-limit.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createNotePersonalStateHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const codec = createIdCodec(config.id);
	const consume = createApiRateLimiter(resources.redis);
	const application = createNotePersonalState({
		...createNotePersonalStateStore(resources.dataSource.manager, codec.createdAtFromId),
		newId: () => codec.newId(Date.now()),
		startAchievement: userId => resources.favoriteAchievements.start(userId),
		async limit(operation, userId, factor) {
			const exceeded = await consume({ key: `notes/${operation}`, duration: 3600000, max: operation === 'favorites/create' ? 20 : 10 }, userId, factor);
			if (exceeded) {
				throw new NotePersonalStateError('RATE_LIMIT_EXCEEDED', 'd5826d14-3982-4d2e-8011-b9e9f02499ef', 'Rate limit exceeded. Please try again later.', exceeded);
			}
		},
	});
	return createApiEndpoints({ authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), endpoints: createNotePersonalStateEndpoints(application), logger: resources.logger });
}
