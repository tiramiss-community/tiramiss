/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Meilisearch } from 'meilisearch';
import { searchDocument, shouldUnindex } from '../modules/search/public.js';
import { DiagnosticError } from './diagnostic-error.js';
import type { SearchNote } from '../modules/search/public.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Logger } from './logger.js';

/** SDK promises resolve at task acceptance. Application work never waits for task application. */
export function createSearchIndex(config: Pick<RuntimeConfig, 'fulltextSearch' | 'meilisearch'>, createdAtFromId: (id: string) => number, logger: Logger) {
	const pending = new Set<Promise<void>>();
	const track = (request: Promise<unknown>): Promise<void> => {
		const task = request.then(() => {});
		pending.add(task);
		void task.then(() => pending.delete(task), () => pending.delete(task));
		return task;
	};
	const selected = config.fulltextSearch?.provider === 'meilisearch';
	if (selected && !config.meilisearch) {
		throw new DiagnosticError('INVALID_CONFIG', { field: 'meilisearch' });
	}
	const options = selected ? config.meilisearch : undefined;
	const index = options ? new Meilisearch({ host: `${options.ssl ? 'https' : 'http'}://${options.host}:${options.port}`, apiKey: options.apiKey }).index(`${options.index}---notes`) : null;
	if (index) {
		// 本家は settings の受付も適用も起動条件にしない。失敗は記録し、開始済みの要求は終了時に待つ。
		void track(index.updateSettings({ searchableAttributes: ['text', 'cw'], sortableAttributes: ['createdAt'], filterableAttributes: ['createdAt', 'userId', 'userHost', 'channelId', 'tags'], typoTolerance: { enabled: false }, pagination: { maxTotalHits: 10000 } })).catch(error => logger.error('search-settings.failed', { error }));
	}
	return {
		async index(note: SearchNote): Promise<void> {
			if (!index) {
				return;
			}
			try {
				const document = searchDocument(note, options?.scope ?? 'local', createdAtFromId);
				if (document) {
					await track(index.addDocuments([document], { primaryKey: 'id' }));
				}
			} catch (error) {
				logger.error('search-index.failed', { error, noteId: note.id });
				throw error;
			}
		},
		async unindex(note: { id: string; visibility: string }): Promise<void> {
			if (!index || !shouldUnindex(note.visibility)) {
				return;
			}
			try {
				await track(index.deleteDocument(note.id));
			} catch (error) {
				logger.error('search-unindex.failed', { error, noteId: note.id });
				throw error;
			}
		},
		async close(): Promise<void> {
			while (pending.size) {
				await Promise.allSettled([...pending]);
			}
		},
	};
}
