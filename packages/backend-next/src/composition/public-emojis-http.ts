/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPublicEmojisApi } from '../http/public-emojis-api.js';
import { createPublicEmojis } from '../modules/emoji/public.js';
import { createPublicEmojiReader } from '../platform/database/public-emojis.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import type { RuntimeResources } from './create-runtime.js';

export function createPublicEmojisHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger'>) {
	return createPublicEmojisApi(createPublicEmojis(createPublicEmojiReader(resources.dataSource.manager)), {
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		logger: resources.logger,
	});
}
