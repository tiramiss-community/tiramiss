/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createRoleHttpApp } from './role-http.js';
import { createNoteApi } from '../http/note-api.js';
import { createShowNote } from '../modules/note/public.js';
import { createNoteReader } from '../platform/database/note-reader.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const show = createShowNote(createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: createIdCodec(config.id).createdAtFromId }));
	return createRoleHttpApp(resources, config).route('/', createNoteApi({ authenticate: createTokenAuthenticator(manager, resources.logger), showNote: show.showNote, logger: resources.logger }));
}
