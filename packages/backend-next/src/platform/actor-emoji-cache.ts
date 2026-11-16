/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull } from 'typeorm';
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
		remote: (names: readonly string[], host: string | null, selfHost: string): Promise<Map<string, string>> => tracked(async () => {
			const rules = createHostRules(selfHost);
			const entries = await Promise.all(names.map(value => tracked(async () => {
				const match = value.match(/^([-\w]+)(?:@([\w.-]+))?$/);
				if (!match) {
					return [];
				}
				const target = rules.emojiHost(match[2], host);
				if (target === null) {
					return [];
				}
				const key = `${match[1]} ${target}`;
				let cached = remote.get(key);
				if (cached && now() - cached.at > 43200000) {
					remote.delete(key); cached = undefined;
				}
				const row = cached ? cached.value : (await repository.findOneBy({ name: match[1], host: target })) ?? null;
				if (!cached) {
					remote.set(key, { at: now(), value: row });
				}
				return row === null ? [] : [[`${match[1]}@${target}`, row.publicUrl || row.originalUrl] as const];
			})));
			return new Map(entries.flat());
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
