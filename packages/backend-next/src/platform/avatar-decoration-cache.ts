/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { AvatarDecoration } from '../modules/avatar-decoration/public.js';
import type { InternalEvents } from './internal-events.js';

export function createAvatarDecorationCache<T extends AvatarDecoration>(options: {
	read(): Promise<T[]>;
	events: Pick<InternalEvents, 'register'>;
	clock?: () => number;
}) {
	const clock = options.clock ?? Date.now;
	let cached: { at: number; value: T[] } | undefined;
	let closed = false;
	const pending = new Set<Promise<T[]>>();
	const unregister = options.events.register({ onInternal(event) {
		if (['avatarDecorationCreated', 'avatarDecorationUpdated', 'avatarDecorationDeleted'].includes(event.type)) {
			cached = undefined;
		}
	} });

	async function getAll(noCache = false): Promise<T[]> {
		if (closed) {
			throw new Error('Avatar decoration cache is closed');
		}
		if (noCache || (cached && clock() - cached.at > 30 * 60 * 1000)) {
			cached = undefined;
		}
		if (cached) {
			return cached.value;
		}
		// Match MemorySingleCache: successful completion starts TTL; concurrent
		// misses are independent and may refill after an intervening event.
		const work = options.read().then(value => {
			cached = { at: clock(), value };
			return value;
		});
		pending.add(work);
		void work.then(() => pending.delete(work), () => pending.delete(work));
		return work;
	}

	let closing: Promise<void> | undefined;

	function close(): Promise<void> {
		if (!closing) {
			closed = true;
			unregister();
			closing = Promise.allSettled([...pending]).then(() => {});
		}
		return closing;
	}

	return { getAll, close };
}
