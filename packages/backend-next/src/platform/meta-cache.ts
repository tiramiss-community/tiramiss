/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MiMeta } from 'backend-upstream/entities';
import type { InternalEvents } from './internal-events.js';

export interface MetaReader {
	fetch(noCache?: boolean): Promise<MiMeta>;
}

export function createMetaCache(options: {
	read(): Promise<MiMeta>;
	events: Pick<InternalEvents, 'register'>;
	periodic?: boolean;
	onError(error: unknown): void;
}) {
	let value: MiMeta | undefined;
	let closed = false;
	const pending = new Set<Promise<MiMeta>>();
	const unregister = options.events.register({ onInternal(event) {
		if (!closed && event.type === 'metaUpdated') {
			value = { ...event.body.after as MiMeta, rootUser: null };
		}
	} });

	async function fetch(noCache = false): Promise<MiMeta> {
		if (closed) {
			throw new Error('Meta cache is closed');
		}
		if (!noCache && value) {
			return value;
		}
		return refresh(options.read);
	}

	async function refresh(read: () => Promise<MiMeta>): Promise<MiMeta> {
		if (closed) {
			throw new Error('Meta cache is closed');
		}
		const work = read().then(meta => {
			// Source permits an in-flight fetch to replace an intervening notification.
			value = meta;
			return meta;
		});
		pending.add(work);
		void work.then(() => pending.delete(work), () => pending.delete(work));
		return work;
	}

	const timer = (options.periodic ?? process.env.NODE_ENV !== 'test') ? setInterval(() => {
		void fetch(true).catch(error => {
			try {
				options.onError(error);
			} catch { /* Diagnostics must not create an unhandled timer rejection. */ }
		});
	}, 300000) : undefined;
	let closing: Promise<void> | undefined;

	function close(): Promise<void> {
		if (!closing) {
			closed = true;
			clearInterval(timer);
			unregister();
			closing = Promise.allSettled([...pending]).then(() => {});
		}
		return closing;
	}

	return { fetch, refresh, close };
}
