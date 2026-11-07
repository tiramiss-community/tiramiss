/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { createNoteDeleteApi } from '../http/note-delete-api.js';
import { createNoteDeleter } from '../platform/database/note-deleter.js';
import { createNoteDeleteRateLimiter } from '../platform/note-delete-rate-limit.js';
import { createNoteApi } from '../http/note-api.js';
import { createNoteCreateApi } from '../http/note-create-api.js';
import { createNoteWriter, createNoteWriteTransactions } from '../platform/database/note-writer.js';
import { createNoteRateLimiter } from '../platform/note-rate-limit.js';
import { createCreateNote, createDeleteNote, createShowNote, matchesWords, readNotePlan, renderNote } from '../modules/note/public.js';
import { createHostRules, renderDeletedNoteActivity } from '../modules/federation/public.js';
import { createNoteReader } from '../platform/database/note-reader.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createRoleHttpApp } from './role-http.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Hono } from 'hono';

export function createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig, queueApi?: Hono) {
	const manager = resources.dataSource.manager;
	const codec = createIdCodec(config.id);
	const reader = createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId });
	const show = createShowNote(reader);
	const writer = createNoteWriter(manager, resources.roleMaterials, codec.createdAtFromId);
	const create = createCreateNote({
		...writer, newId: codec.newId, currentTime: Date.now, matchesWords,
		isSelfHost: createHostRules(new URL(config.url).host).isSelfHost,
		transactions: createNoteWriteTransactions(resources.dataSource),
		limit: createNoteRateLimiter(resources.redis),
		afterSaved: input => resources.notePostSave.start(input),
	});
	const deletion = createDeleteNote({
		...createNoteDeleter(manager, codec.createdAtFromId),
		limit: createNoteDeleteRateLimiter(resources.redis),
		renderActivity: (snapshot, now) => renderDeletedNoteActivity(snapshot, {
			selfUrl: config.url, now, randomId: randomUUID(), isLocalUri: createHostRules(new URL(config.url).host).isUriLocal,
		}),
		start: resources.notePostDelete.start,
		publishDeleted: (snapshot, occurredAtMs) => resources.notePostDelete.start({ kind: 'stream', snapshot, occurredAtMs }),
	});
	const authenticate = createTokenAuthenticator(manager, resources.logger);
	const app = createRoleHttpApp(resources, config)
		.route('/', createNoteDeleteApi({ authenticate, deleteNote: deletion.deleteNote, logger: resources.logger }))
		.route('/', createNoteApi({ authenticate, showNote: show.showNote, logger: resources.logger }))
		.route('/', createNoteCreateApi({
			authenticate, createNote: create.createNote, logger: resources.logger,
			readCreatedNote: async (id, viewerId, now) => {
				const notes = await readNotePlan([id], reader.readNotes);
				return renderNote(id, await reader.readMaterials(notes, viewerId, now), viewerId, now);
			},
		}));
	if (queueApi) {
		app.route('/', queueApi);
	}
	return app;
}
