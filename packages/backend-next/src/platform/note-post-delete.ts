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

	function track(task: Promise<void>, noteId: string, userId: string, kind: string): void {
		const handled = task.catch(error => {
			logger.error('note-post-delete.failed', { error, noteId, userId, kind });
		});
		pending.add(handled);
		void handled.then(() => pending.delete(handled));
	}

	return {
		trackRemoval(task: Promise<void>, noteId: string, userId: string): void {
			track(task, noteId, userId, 'unrenote');
		},
		start(input: NoteDeleteWork): void {
			// 配送は本家どおり DELETE より前に開始する。setImmediate で削除成功後まで遅延させない。
			track((async () => run(input))(), input.snapshot.id, input.snapshot.userId, input.kind);
		},
		idle,
		close: idle,
	};
}
