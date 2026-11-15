/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { openInternalEvents } from './internal-events.js';
import type { InternalEvent, InternalEvents } from './internal-events.js';
import type { RedisConfig } from '../config/types.js';
import type { AntennaDefinition } from '../modules/note/public.js';
type Followings = Record<string, {
	withReplies: boolean;
} | undefined>;
interface AntennaCacheOptions {
	reader: {
		active(): Promise<AntennaDefinition[]>;
		followings(ownerId: string): Promise<{
			followeeId: string;
			withReplies: boolean;
		}[]>;
	};
	redis: {
		get(key: string): Promise<string | null>;
		set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
		del(key: string): Promise<unknown>;
	};
	currentTime(): number;
	onError(error: unknown): void;
}
/** 本家の遅延一覧と userFollowingsCache に限定した状態。 */
export function createNoteAntennaCache(options: AntennaCacheOptions) {
	let antennas: AntennaDefinition[] = [];
	let fetched = false;
	const memory = new Map<string, {
		value: Followings;
		at: number;
	}>();
	const pending = new Set<Promise<void>>();
	const gc = setInterval(() => {
		for (const [id, cached] of memory) {
			if (options.currentTime() - cached.at >= 60000) {
				memory.delete(id);
			}
		}
	}, 180000);
	gc.unref();
	return {
		async definitions(): Promise<AntennaDefinition[]> {
			// 本家と同じく single-flight や世代番号を持たず、cold fetch の完了が一覧を置き換える。
			if (!fetched) {
				antennas = await options.reader.active();
				fetched = true;
			}
			return antennas;
		},
		async followingIds(ownerId: string): Promise<ReadonlySet<string>> {
			const cached = memory.get(ownerId);
			if (cached && options.currentTime() - cached.at <= 60000) {
				return new Set(Object.keys(cached.value));
			}
			memory.delete(ownerId);
			const key = `kvcache:userFollowings:${ownerId}`;
			const encoded = await options.redis.get(key);
			if (encoded !== null) {
				const value: Followings = JSON.parse(encoded);
				memory.set(ownerId, { value, at: options.currentTime() });
				return new Set(Object.keys(value));
			}
			const value: Followings = {};
			for (const row of await options.reader.followings(ownerId)) {
				value[row.followeeId] = { withReplies: row.withReplies };
			}
			memory.set(ownerId, { value, at: options.currentTime() });
			await options.redis.set(key, JSON.stringify(value), 'EX', 1800);
			return new Set(Object.keys(value));
		},
		onInternal({ type, body: input }: InternalEvent): void {
			if (type.startsWith('antenna')) {
				if (typeof input.id !== 'string') {
					return;
				}
				if (type !== 'antennaDeleted' && (typeof input.userId !== 'string'
					|| typeof input.src !== 'string' || !['home', 'all', 'users', 'list', 'users_blacklist'].includes(input.src)
					|| !(input.userListId === null || typeof input.userListId === 'string')
					|| !Array.isArray(input.users) || !input.users.every(value => typeof value === 'string')
					|| ![input.keywords, input.excludeKeywords].every(value => Array.isArray(value) && value.every(row => Array.isArray(row) && row.every(word => typeof word === 'string')))
					|| !['caseSensitive', 'excludeBots', 'withReplies', 'withFile', 'isActive', 'localOnly', 'excludeNotesInSensitiveChannel'].every(key => typeof input[key] === 'boolean'))) {
					return;
				}
			}
			const body = input as unknown as AntennaDefinition & { followerId?: string };
			if (type === 'antennaCreated') {
				antennas.push(body);
			}
			if (type === 'antennaUpdated') {
				const index = antennas.findIndex(antenna => antenna.id === body.id);
				if (index < 0) {
					antennas.push(body);
				} else {
					antennas[index] = body;
				}
			}
			if (type === 'antennaDeleted') {
				antennas = antennas.filter(antenna => antenna.id !== body.id);
			}
			if (type === 'follow' && typeof body.followerId === 'string') {
				memory.delete(body.followerId);
				const work = (async () => {
					await options.redis.del(`kvcache:userFollowings:${body.followerId}`);
				})().catch(options.onError);
				pending.add(work);
				void work.then(() => pending.delete(work));
			}
		},
		async close(): Promise<void> {
			clearInterval(gc);
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
			memory.clear();
		},
	};
}
export async function openNoteAntennas(options: AntennaCacheOptions & {
	events?: InternalEvents;
	subscriberConfig: RedisConfig;
	url: string;
	timeoutMs: number;
	registerCleanup?(cleanup: () => Promise<void>): void;
}) {
	const cache = createNoteAntennaCache(options);
	let receiver: InternalEvents | undefined;
	let unregister = () => {};
	let closeTransport: (() => Promise<void>) | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		unregister();
		closing ??= Promise.all([cache.close(), options.events ? Promise.resolve() : closeTransport?.()]).then(() => {});
		return closing;
	};
	options.registerCleanup?.(close);
	try {
		receiver = options.events ?? await openInternalEvents({ subscriberConfig: options.subscriberConfig, url: options.url, timeoutMs: options.timeoutMs, onError: options.onError, registerCleanup: close => {
			closeTransport = close;
		} });
		if (closing) {
			if (!options.events) {
				await receiver.close();
			}
		} else {
			unregister = receiver.register({ onInternal: cache.onInternal });
		}
	} catch (error) {
		await close();
		throw error;
	}
	return { definitions: cache.definitions, followingIds: cache.followingIds, close };
}
