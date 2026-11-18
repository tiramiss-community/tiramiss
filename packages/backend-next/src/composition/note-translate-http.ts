/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createTranslateNote } from '../modules/note-translate/public.js';
import { createNoteTranslateApi } from '../http/note-translate-api.js';
import { createNoteTranslationReader } from '../platform/database/note-translate.js';
import { createNoteReader } from '../platform/database/note-reader.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createNoteTranslateHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const codec = createIdCodec(config.id);
	const application = createTranslateNote({
		...createNoteTranslationReader(manager, codec.createdAtFromId),
		notes: createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis),
		readSettings: async () => {
			const { deeplAuthKey, deeplIsPro } = await resources.meta.fetch();
			return { deeplAuthKey, deeplIsPro };
		},
		send: (...args) => resources.outboundHttp.send(...args),
	});
	return createNoteTranslateApi({ ...application, authenticate: createTokenAuthenticator(manager, resources.logger), logger: resources.logger });
}
