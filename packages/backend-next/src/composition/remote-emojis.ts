/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { extractRemoteEmojis } from '../modules/federation/public.js';
import type { RemoteEmojiRepository } from '../modules/federation/public.js';

export function createRemoteEmojis(
	repository: RemoteEmojiRepository,
	clock: { now(): number; newId(): string },
	reportTagFailure?: (error: unknown, host: string) => void,
) {
	const pending = new Set<Promise<void>>();

	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return {
		extract: (tags: unknown, host: string) => extractRemoteEmojis(tags, host, {
			...repository, ...clock,
			track(work) {
				// Keep the complete tag operation alive after Promise.all has already rejected its caller.
				const settled = work.then(() => { }, error => {
					try {
						reportTagFailure?.(error, host);
					} catch {
						// A failed diagnostic must not interrupt draining other tag operations.
					}
				});
				pending.add(settled);
				void settled.then(() => pending.delete(settled));
			},
		}),
		idle, close: idle,
	};
}
