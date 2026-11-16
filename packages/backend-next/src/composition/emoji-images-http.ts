/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createEmojiImagesApi } from '../http/emoji-images-api.js';
import { createEmojiImageAssets } from '../platform/images/emoji-image-assets.js';

export function createEmojiImagesHttp() {
	const require = createRequire(import.meta.url);
	return createEmojiImagesApi(createEmojiImageAssets({
		fluentEmojiDir: dirname(require.resolve('@misskey-dev/emoji-assets/fluent-emoji/1f600.png')),
		twemojiDir: dirname(require.resolve('@misskey-dev/emoji-assets/twemoji/1f600.svg')),
	}));
}
