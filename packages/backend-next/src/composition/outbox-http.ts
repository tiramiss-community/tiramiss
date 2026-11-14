/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createActivityPubOutboxApi } from '../http/activitypub-outbox-api.js';
import { readOutboxNotes, renderOutboxCollection } from '../modules/federation/public.js';
import { createNotePublicationReader } from '../platform/database/local-featured.js';
import { createLocalActivityReader, createOutboxReader } from '../platform/database/local-outbox.js';
import { readMeta } from '../platform/database/meta.js';
import { createIdCodec } from '../platform/id-codec.js';
import { preparePublishedActivity } from './published-activity.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createOutboxHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const { createdAtFromId } = createIdCodec(config.id);
	const publication = createNotePublicationReader(manager, { ...config.noteMedia, url: config.url, createdAtFromId });
	const reader = createOutboxReader(manager, resources.timelinesRedis);
	const render = (note: Parameters<typeof preparePublishedActivity>[0]) => preparePublishedActivity(note, publication, { selfUrl: config.url, now: Date.now(), createdAtFromId });
	return createActivityPubOutboxApi({
		logger: resources.logger,
		federationEnabled: async () => (await readMeta(manager)).federation !== 'none',
		readLocalActivityNote: createLocalActivityReader(manager), renderActivity: render,
		async readOutbox(id, page, bounds) {
			const user = await reader.readLocalUser(id);
			if (user === null) {
				return null;
			}
			if (!page) {
				return renderOutboxCollection(id, user.notesCount, null, config.url);
			}
			const meta = await readMeta(manager);
			const notes = await readOutboxNotes(user.id, bounds, meta.enableFanoutTimeline, meta, reader);
			if (bounds.sinceId) {
				notes.reverse();
			}
			const activities = await Promise.all(notes.map(render));
			return renderOutboxCollection(id, user.notesCount, { bounds, notes, activities }, config.url);
		},
	});
}
