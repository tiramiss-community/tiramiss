/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface ApiIpRow { userId: string; ip: string; createdAt: Date }

/** One history per HTTP process, matching ApiCallService's hourly reset. */
export function createApiIpLog(options: {
	enabled(): Promise<boolean>;
	insert(row: ApiIpRow): Promise<unknown>;
	now(): Date;
	onError(error: unknown): void;
}) {
	const histories = new Map<string, Set<string>>();
	const pending = new Set<Promise<void>>();
	let closed = false;
	const timer = setInterval(() => histories.clear(), 3600000);
	timer.unref();
	let closing: Promise<void> | undefined;

	function record(userId: string | null, ip: string): void {
		if (closed || userId === null) {
			return;
		}
		const work = (async () => {
			if (!await options.enabled()) {
				return;
			}
			let ips = histories.get(userId);
			if (ips?.has(ip)) {
				return;
			}
			if (!ips) {
				ips = new Set();
				histories.set(userId, ips);
			}
			// Failed inserts remain suppressed until the next global reset, as upstream does.
			ips.add(ip);
			await options.insert({ userId, ip, createdAt: options.now() });
		})().catch(error => {
			try {
				options.onError(error);
			} catch { /* Diagnostics cannot turn an accepted API call into an unhandled rejection. */ }
		});
		pending.add(work);
		void work.then(() => pending.delete(work));
	}

	const idle = async () => {
		await Promise.all([...pending]);
	};

	function close(): Promise<void> {
		closed = true;
		clearInterval(timer);
		return closing ??= idle();
	}

	return { record, idle, close };
}
