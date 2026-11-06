/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteDeleteWork } from '../modules/note/public.js';
import type { Logger } from './logger.js';

export function createNotePostDelete(run: (input: NoteDeleteWork) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();

	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return {
		start(input: NoteDeleteWork): void {
			// 配送は本家どおり DELETE より前に開始する。setImmediate で削除成功後まで遅延させない。
			const task = (async () => run(input))().catch(error => {
				logger.error('note-post-delete.failed', { error, noteId: input.snapshot.id, userId: input.snapshot.userId, kind: input.kind });
			});
			pending.add(task);
			void task.then(() => pending.delete(task));
		},
		idle,
		close: idle,
	};
}
