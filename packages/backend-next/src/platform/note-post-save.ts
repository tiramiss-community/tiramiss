/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { setImmediate } from 'node:timers/promises';
import type { Logger } from './logger.js';

export function createNotePostSave(incrementCount: (userId: string) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();
	return {
		start(userId: string): void {
			const work = setImmediate().then(() => incrementCount(userId)).catch(error => {
				logger.error('note-post-save.failed', { error, userId });
			});
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		async close(): Promise<void> {
			await Promise.all([...pending]);
		},
	};
}
