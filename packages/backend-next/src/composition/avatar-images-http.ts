/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createAvatarImagesApi } from '../http/avatar-images-api.js';
import { createAvatarImageReader } from '../platform/database/avatar-images.js';
import { genIdenticon } from '../platform/images/identicon.js';
import type { RuntimeConfig } from '../config/types.js';
import type { RuntimeResources } from './create-runtime.js';

export function createAvatarImagesHttp(resources: Pick<RuntimeResources, 'dataSource' | 'meta'>, config: Pick<RuntimeConfig, 'url' | 'noteMedia'>) {
	return createAvatarImagesApi({
		reader: createAvatarImageReader(resources.dataSource.manager),
		readSettings: resources.meta.fetch,
		generate: genIdenticon,
		url: config.url,
		mediaProxy: config.noteMedia?.mediaProxy ?? `${config.url}/proxy`,
	});
}
