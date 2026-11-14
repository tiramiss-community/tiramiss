/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createActivityPubEmojiApi } from '../http/activitypub-emoji-api.js';
import { renderApEmoji } from '../modules/federation/public.js';
import { createLocalEmojiObjectReader } from '../platform/database/local-emoji-object.js';
import { readMeta } from '../platform/database/meta.js';
import type { RuntimeConfig } from '../config/types.js';
import type { RuntimeResources } from './create-runtime.js';

export function createEmojiHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	return createActivityPubEmojiApi({
		logger: resources.logger,
		federationEnabled: async () => (await readMeta(manager)).federation !== 'none',
		readEmoji: createLocalEmojiObjectReader(manager),
		renderEmoji: emoji => renderApEmoji(emoji, config.url, Date.now()),
	});
}
