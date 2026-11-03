/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createNoteApi } from '../http/note-api.js';
import { createNoteCreateApi } from '../http/note-create-api.js';
import { createNoteWriter } from '../platform/database/note-writer.js';
import { createNoteRateLimiter } from '../platform/note-rate-limit.js';
import { createCreateNote, createShowNote, matchesWords, readNotePlan, renderNote } from '../modules/note/public.js';
import { createNoteReader } from '../platform/database/note-reader.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createRoleHttpApp } from './role-http.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const codec = createIdCodec(config.id);
	const reader = createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId });
	const show = createShowNote(reader);
	const writer = createNoteWriter(manager, resources.roleMaterials, codec.createdAtFromId);
	const create = createCreateNote({
		...writer, newId: codec.newId, matchesWords,
		limit: createNoteRateLimiter(resources.redis),
		afterSaved: note => resources.notePostSave.start(note.userId),
	});
	const authenticate = createTokenAuthenticator(manager, resources.logger);
	return createRoleHttpApp(resources, config)
		.route('/', createNoteApi({ authenticate, showNote: show.showNote, logger: resources.logger }))
		.route('/', createNoteCreateApi({
			authenticate, createNote: create.createNote, logger: resources.logger,
			readCreatedNote: async (id, viewerId, now) => {
				const notes = await readNotePlan([id], reader.readNotes);
				return renderNote(id, await reader.readMaterials(notes, viewerId, now), viewerId, now);
			},
		}));
}
