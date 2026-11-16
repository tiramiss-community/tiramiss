/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiEmoji } from 'backend-upstream/entities';
import { createHostRules } from '../modules/federation/public.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
import type { ApEmojiFacts } from '../modules/federation/public.js';

export function createActorEmojiCache(manager: EntityManager, redis: Redis, now: () => number = Date.now) {
	const repository = manager.getRepository(MiEmoji);
	let local: { at: number; value: Map<string, MiEmoji> } | undefined;
	const remote = new Map<string, { at: number; value: MiEmoji | null }>();
	let closed = false;
	const pending = new Set<Promise<unknown>>();
	const timer = setInterval(() => {
		const instant = now();
		for (const [key, value] of remote) {
			if (instant - value.at >= 43200000) {
				remote.delete(key);
			}
		}
	}, 180000);

	async function tracked<T>(work: () => Promise<T>): Promise<T> {
		if (closed) {
			throw Error('Actor emoji cache is closed');
		}
		const promise = work(); pending.add(promise);
		try {
			return await promise;
		} finally {
			pending.delete(promise);
		}
	}

	async function localMap() {
		if (local && now() - local.at <= 180000) {
			return local.value;
		}
		const serialized = await redis.get('singlecache:localEmojis');
		if (serialized !== null) {
			const rows = JSON.parse(serialized) as MiEmoji[];
			const value = new Map(rows.map(row => [row.name, { ...row, updatedAt: row.updatedAt ? new Date(row.updatedAt) : null }]));
			local = { at: now(), value }; return value;
		}
		const value = new Map((await repository.findBy({ host: IsNull() })).map(row => [row.name, row]));
		// Source populates memory before waiting for the Redis write, including failed writes.
		local = { at: now(), value };
		await redis.set('singlecache:localEmojis', JSON.stringify([...value.values()]), 'EX', 1800);
		return value;
	}

	return {
		local: (names: readonly string[]): Promise<ApEmojiFacts[]> => tracked(async () => {
			if (names.length === 0) {
				return [];
			}
			const map = await localMap();
			return names.flatMap(name => {
				const row = map.get(name);
				return row ? [{ name: row.name, type: row.type, publicUrl: row.publicUrl, originalUrl: row.originalUrl, license: row.license, localOnly: row.localOnly, updatedAtMs: row.updatedAt?.getTime() ?? null }] : [];
			});
		}),
		remote: (users: readonly { emojis: readonly string[]; host: string | null }[], selfHost: string): Promise<Map<string, string>> => tracked(async () => {
			const rules = createHostRules(selfHost);
			const requested = new Map<string, { name: string; host: string }>();
			for (const user of users) {
				for (const value of user.emojis) {
					const match = value.match(/^([-\w]+)(?:@([\w.-]+))?$/);
					if (!match) {
						continue;
					}
					const host = rules.emojiHost(match[2], user.host);
					if (host !== null) {
						requested.set(`${match[1]} ${host}`, { name: match[1], host });
					}
				}
			}
			const values = new Map<string, MiEmoji | null>();
			const missing = new Map<string, { name: string; host: string }>();
			for (const [key, query] of requested) {
				const cached = remote.get(key);
				if (cached && now() - cached.at <= 43200000) {
					values.set(key, cached.value);
				} else {
					remote.delete(key); missing.set(key, query);
				}
			}
			if (missing.size > 0) {
				const hosts = new Map<string, string[]>();
				for (const { name, host } of missing.values()) {
					const names = hosts.get(host) ?? [];
					names.push(name); hosts.set(host, names);
				}
				// Keep the Note reader's collection query without refreshing positive or null hits.
				const rows = await repository.findBy([...hosts].map(([host, names]) => ({ host, name: In(names) })));
				const found = new Map(rows.map(row => [`${row.name} ${row.host}`, row]));
				for (const [key] of missing) {
					const value = found.get(key) ?? null;
					remote.set(key, { at: now(), value }); values.set(key, value);
				}
			}
			return new Map([...requested].flatMap(([key, { name, host }]) => {
				const row = values.get(key);
				return row == null ? [] : [[`${name}@${host}`, row.publicUrl || row.originalUrl] as const];
			}));
		}),
		async close() {
			closed = true; clearInterval(timer);
			while (pending.size) {
				await Promise.allSettled([...pending]);
			}
			local = undefined; remote.clear();
		},
	};
}
export type ActorEmojiCache = ReturnType<typeof createActorEmojiCache>;
