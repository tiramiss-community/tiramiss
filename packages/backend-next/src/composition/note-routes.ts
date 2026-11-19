/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { createPollRecommendationHttp } from './poll-recommendation-http.js';
import { createNoteDeleteApi } from '../http/note-delete-api.js';
import { createNoteDeleter } from '../platform/database/note-deleter.js';
import { createNoteDeleteRateLimiter } from '../platform/note-delete-rate-limit.js';
import { createNoteApi } from '../http/note-api.js';
import { createNotesListApi } from '../http/notes-list-api.js';
import { createListNotes } from '../modules/note/public.js';
import { createNotesListReader } from '../platform/database/note-list.js';
import { createNoteCreateApi } from '../http/note-create-api.js';
import { createNoteRateLimiter } from '../platform/note-rate-limit.js';
import { createDeleteNote, createUnrenote, removeNote, createShowNote, readNotePlan, renderNote } from '../modules/note/public.js';
import { createHostRules, renderDeletedNoteActivity } from '../modules/federation/public.js';
import { readFromPrimary } from '../platform/database/primary-read.js';
import { createNoteReader } from '../platform/database/note-reader.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createIdCodec } from '../platform/id-codec.js';
import { createNoteApplication } from './note.js';
import { createRemoteUsers } from './remote-users.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Hono } from 'hono';
import type { NoteDeletionPorts } from '../modules/note/public.js';

export function prepareNoteRoutes(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const codec = createIdCodec(config.id);
	const reader = createNoteReader(manager, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis);
	const show = createShowNote(reader);
	const list = createListNotes(createNotesListReader(manager, resources.reactionsRedis,
		{ ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis), codec.newId);
	const create = createNoteApplication({
		dataSource: resources.dataSource, roleMaterials: resources.roleMaterials, ids: codec, clock: Date.now,
		remoteUsers: createRemoteUsers(resources, config),
		limit: createNoteRateLimiter(resources.redis),
		afterSaved: input => resources.notePostSave.start(input),
	});
	const deleter = createNoteDeleter(manager, codec.createdAtFromId);
	const deletionPorts: NoteDeletionPorts = {
		...deleter,
		limit: createNoteDeleteRateLimiter(resources.redis),
		renderActivity: (snapshot, now) => renderDeletedNoteActivity(snapshot, {
			selfUrl: config.url, now, randomId: randomUUID(), isLocalUri: createHostRules(new URL(config.url).host).isUriLocal,
		}),
		start: resources.notePostDelete.start,
		publishDeleted: (snapshot, occurredAtMs) => resources.notePostDelete.start({ kind: 'stream', snapshot, occurredAtMs }),
	};
	const deletion = createDeleteNote(deletionPorts);
	const unrenote = createUnrenote({
		readActor: deletionPorts.readActor,
		limit: createNoteDeleteRateLimiter(resources.redis, 'notes/unrenote'),
		readTarget: deleter.readTarget,
		readOwnRenotes: deleter.readOwnRenotes,
		startRemoval: (snapshot, userId, now) => {
			resources.notePostDelete.trackRemoval(removeNote(snapshot, userId, now, deletionPorts), snapshot.id, userId);
		},
	});
	const authenticate = createTokenAuthenticator(manager, resources.logger);
	const readCreatedNote = (id: string, viewerId: string, now: number) => readFromPrimary(resources.dataSource, async primary => {
		// The saved note and Poll may not have reached a replica when the create response is rendered.
		const createdReader = createNoteReader(primary, resources.reactionsRedis, { ...config.noteMedia, url: config.url, createdAtFromId: codec.createdAtFromId }, resources.actorEmojis);
		const notes = await readNotePlan([id], createdReader.readNotes);
		return renderNote(id, await createdReader.readMaterials(notes, viewerId, now), viewerId, now);
	});
	return { authenticate, deletion, unrenote, show, list, create, reader, readCreatedNote, pollRecommendation: createPollRecommendationHttp(resources, config) };
}

export function registerNoteRoutes(app: Hono, resources: RuntimeResources, prepared: ReturnType<typeof prepareNoteRoutes>) {
	const { authenticate, deletion, unrenote, show, list, create, readCreatedNote } = prepared;
	return app
		.route('/', prepared.pollRecommendation)
		.route('/', createNotesListApi({ authenticate, listNotes: list.listNotes, logger: resources.logger }))
		.route('/', createNoteDeleteApi({ authenticate, deleteNote: deletion.deleteNote, logger: resources.logger }))
		.route('/', createNoteDeleteApi({ authenticate, deleteNote: unrenote.unrenote, logger: resources.logger, endpoint: 'unrenote' }))
		.route('/', createNoteApi({ authenticate, showNote: show.showNote, logger: resources.logger }))
		.route('/', createNoteCreateApi({
			authenticate, createNote: create.createNote, logger: resources.logger,
			readCreatedNote,
		}));
}
