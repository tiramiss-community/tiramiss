/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote } from 'backend-upstream/entities';
import { createSearchIndex } from '../platform/search-index.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { NoteCreatedSnapshot } from '../modules/note/public.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Logger } from '../platform/logger.js';
import type { EntityManager } from 'typeorm';

export function createPostingSearch(manager: EntityManager, config: RuntimeConfig, logger: Logger) {
	const search = createSearchIndex(config, createIdCodec(config.id).createdAtFromId, logger);
	return {
		async index(noteId: string, snapshot?: NoteCreatedSnapshot): Promise<void> {
			if (config.fulltextSearch?.provider !== 'meilisearch') {
				return;
			}
			const note = snapshot?.note ?? await manager.findOneBy(MiNote, { id: noteId });
			if (note) {
				await search.index(note);
			}
		},
		unindex: search.unindex,
		close: search.close,
	};
}
