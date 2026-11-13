/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createActivityPubNotesApi } from '../http/activitypub-notes-api.js';
import { createHostRules, readFeaturedNotes, renderApNote, renderFeaturedCollection } from '../modules/federation/public.js';
import { createFeaturedReader, createNotePublicationReader, createPublicNoteReader } from '../platform/database/local-featured.js';
import { readMeta } from '../platform/database/meta.js';
import { createIdCodec } from '../platform/id-codec.js';
import { preparePublishedNote } from './published-note.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
export function createFeaturedHttp(resources: RuntimeResources, config: RuntimeConfig) {
	const manager = resources.dataSource.manager;
	const { createdAtFromId } = createIdCodec(config.id);
	const reader = createNotePublicationReader(manager, { ...config.noteMedia, url: config.url, createdAtFromId });
	const featured = createFeaturedReader(manager);
	const options = () => ({ selfUrl: config.url, now: Date.now(), createdAtFromId });
	return createActivityPubNotesApi({
		selfUrl: config.url, production: process.env.NODE_ENV === 'production', allowExternalApRedirect: async () => (await readMeta(manager)).allowExternalApRedirect, logger: resources.logger,
		federationEnabled: async () => (await readMeta(manager)).federation !== 'none',
		isSelfHost: createHostRules(new URL(config.url).host).isSelfHost,
		readPublicNote: createPublicNoteReader(manager),
		async readFeatured(id) {
			const notes = await readFeaturedNotes(id, featured);
			if (notes === null) {
				return null;
			}
			const at = options();
			const items = await Promise.all(notes.map(async (note) => renderApNote(await preparePublishedNote(note, reader, at), at)));
			return renderFeaturedCollection(id, items, config.url);
		},
		async renderNote(note) {
			const at = options();
			return renderApNote(await preparePublishedNote(note, reader, at, false), at, false);
		},
	});
}
