/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import type { RedisConfig, RoleCacheConfig } from '../config/types.js';
import type { RoleChanges, RoleDefinitionsChanged } from '../modules/role/public.js';
import { RoleMaterialCache } from './role-material-cache.js';
import type { RoleMaterialReader } from './role-material-cache.js';

export async function openRoleMaterials(options: {
	source: RoleMaterialReader;
	publisher: Redis;
	subscriberConfig: RedisConfig;
	config: RoleCacheConfig;
	clock?: () => number;
	registerCleanup?: (cleanup: () => Promise<void>) => void;
}) {
	const cache = new RoleMaterialCache(options.source, options.config, options.clock);
	// keyPrefixはpub/subのchannelには適用されない。
	const channel = `${options.subscriberConfig.prefix}:backend-next:role-materials:v1`;
	const subscriber = new Redis({
		...options.subscriberConfig,
		lazyConnect: true,
		enableOfflineQueue: false,
		autoResubscribe: false,
		disconnectTimeout: 0,
		maxRetriesPerRequest: 0,
		retryStrategy: attempt => Math.min(attempt * 100, 1000),
	});
	let closed = false;
	let subscribed = false;
	let generation = 0;
	let initial = true;

	const reset = () => {
		generation++;
		subscribed = false;
		cache.clear();
	};
	const subscribe = async () => {
		reset();
		const current = generation;
		await subscriber.subscribe(channel);
		if (!closed && current === generation && subscriber.status === 'ready') {
			subscribed = true;
		}
	};
	subscriber.on('close', reset);
	// 再接続時はsubscribe応答を受け取るまで通常参照を許可しない。
	subscriber.on('ready', () => {
		if (!initial && !closed) {
			void subscribe().catch(() => { /* 次の再接続か終了まで参照を拒否する。 */ });
		}
	});
	subscriber.on('error', () => { /* 接続状態で参照を拒否し、起動失敗は呼出側へ返す。 */ });
	subscriber.on('message', (receivedChannel, payload) => {
		if (receivedChannel !== channel || closed) {
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(payload);
		} catch {
			return;
		}
		if (value && typeof value === 'object' && 'kind' in value && value.kind === 'role-definitions-changed') {
			cache.invalidateRoles();
		}
	});

	const assertAvailable = () => {
		if (closed || !subscribed || subscriber.status !== 'ready' || options.publisher.status !== 'ready') {
			throw new Error('Role material Redis connection is unavailable');
		}
	};
	let closing: Promise<void> | undefined;
	const close = () => {
		closed = true;
		reset();
		closing ??= subscriber.status === 'end' ? Promise.resolve() : new Promise<void>(resolve => {
			subscriber.once('end', resolve);
			subscriber.disconnect();
		});
		return closing;
	};
	options.registerCleanup?.(close);
	try {
		await subscriber.connect();
		await subscribe();
		initial = false;
		assertAvailable();
	} catch (error) {
		await close();
		throw error;
	}

	const read = async <T>(load: () => Promise<T>) => {
		assertAvailable();
		const current = generation;
		const value = await load();
		assertAvailable();
		if (current !== generation) {
			throw new Error('Role material subscription changed during the read');
		}
		return value;
	};
	const changes: RoleChanges = {
		invalidateLocal: () => cache.invalidateRoles(),
		publish: async (event: RoleDefinitionsChanged) => {
			assertAvailable();
			await options.publisher.publish(channel, JSON.stringify(event));
		},
	};
	return {
		readRoles: () => read(() => cache.readRoles()),
		readAssignments: (userId: string) => read(() => cache.readAssignments(userId)),
		changes,
		close,
	};
}
