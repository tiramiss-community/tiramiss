/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { setImmediate } from 'node:timers/promises';
import type { NotePostSaveInput } from '../modules/note/public.js';
import type { Logger } from './logger.js';

export function createNotePostSave(run: (input: NotePostSaveInput) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();

	// 待つ間に開始された処理も待つ。
	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return {
		start(input: NotePostSaveInput): void {
			const work = setImmediate().then(() => run(input)).catch(error => {
				// 加算の欠けた行を後から補えるよう、対象の ID をすべて残す。
				logger.error('note-post-save.failed', { error, ...input });
			});
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		// 開始済みの後続処理がすべて終わるまで待つ。
		idle,
		close: idle,
	};
}
