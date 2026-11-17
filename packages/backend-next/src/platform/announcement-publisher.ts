/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Logger } from './logger.js';

export function createAnnouncementPublisher(send: (userId: string) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();
	return {
		publish(userId: string): void {
			// The pinned stream publisher does not make its Redis result part of a saved read's HTTP result.
			const work = Promise.resolve().then(() => send(userId)).then(() => {}, error => {
				logger.error('announcement-publish.failed', { userId, error });
			});
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		async idle(): Promise<void> {
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
	};
}
