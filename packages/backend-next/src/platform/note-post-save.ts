/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { setImmediate } from 'node:timers/promises';
import type { NotePostSaveInput } from '../modules/note/public.js';
import type { Logger } from './logger.js';

export function createNotePostSave(run: (input: NotePostSaveInput) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();
	return {
		start(input: NotePostSaveInput): void {
			const work = setImmediate().then(() => run(input)).catch(error => {
				logger.error('note-post-save.failed', { error, userId: input.userId });
			});
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		async close(): Promise<void> {
			await Promise.all([...pending]);
		},
	};
}
