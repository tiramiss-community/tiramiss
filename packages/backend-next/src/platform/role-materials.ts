/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Redis } from 'ioredis';
import { openInternalEvents, roleMaterialTopic } from './internal-events.js';
import type { InternalEvents } from './internal-events.js';
import type { RedisConfig, RoleCacheConfig } from '../config/types.js';
import type { RoleChanges, RoleDefinitionsChanged } from '../modules/role/public.js';
import { RoleMaterialCache } from './role-material-cache.js';
import type { RoleMaterialReader } from './role-material-cache.js';

export async function openRoleMaterials(options: {
	source: RoleMaterialReader;
	events?: InternalEvents;
	url?: string;
	publisher: Redis;
	subscriberConfig: RedisConfig;
	config: RoleCacheConfig;
	clock?: () => number;
	registerCleanup?: (cleanup: () => Promise<void>) => void;
}) {
	const cache = new RoleMaterialCache(options.source, options.config, options.clock);
	const channel = roleMaterialTopic(options.subscriberConfig.prefix);
	let closed = false;
	const receiver = options.events ?? await openInternalEvents({
		subscriberConfig: options.subscriberConfig, url: options.url, privateRoleTopic: channel,
		onError: () => {}, registerCleanup: options.registerCleanup,
	});
	const unregister = receiver.register({
		onLost: () => cache.clear(),
		onRoleChange: () => cache.invalidateRoles(),
		onInternal: ({ type, body }) => {
			if (type === 'policiesUpdated' || (['roleCreated', 'roleUpdated', 'roleDeleted'].includes(type) && typeof body.id === 'string')) {
				// Base policies are read from DB per evaluation; notification payloads are never authority.
				cache.invalidateRoles();
			}
			if (['userRoleAssigned', 'userRoleUnassigned'].includes(type) && typeof body.id === 'string' && typeof body.userId === 'string') {
				cache.invalidateAssignments(body.userId);
			}
		},
	});
	const assertAvailable = () => {
		if (closed || !receiver.available() || options.publisher.status !== 'ready') {
			throw new Error('Role material Redis connection is unavailable');
		}
	};
	let closing: Promise<void> | undefined;
	const close = () => {
		closed = true;
		unregister();
		cache.clear();
		closing ??= options.events ? Promise.resolve() : receiver.close();
		return closing;
	};
	options.registerCleanup?.(close);

	const read = async <T>(load: () => Promise<T>) => {
		assertAvailable();
		const current = receiver.generation();
		const value = await load();
		assertAvailable();
		if (current !== receiver.generation()) {
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
