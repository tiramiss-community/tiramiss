/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import { createDataSource } from './database/data-source.js';
import type { RedisConfig, RuntimeConfig } from '../config/types.js';

export async function checkConnections(config: RuntimeConfig) {
	const timeoutMs = config.processes.startupTimeoutMs;
	const checks: { target: string; ready: boolean }[] = [];
	const database = async () => {
		const source = createDataSource(config.database, timeoutMs);
		try {
			await source.initialize();
		} finally {
			if (source.isInitialized) {
				await source.destroy();
			}
		}
	};
	const redis = async (options: RedisConfig) => {
		const client = new Redis({
			...options, lazyConnect: true, connectTimeout: timeoutMs,
			commandTimeout: timeoutMs, retryStrategy: () => null,
			reconnectOnError: () => false, maxRetriesPerRequest: 0,
			enableOfflineQueue: false, disconnectTimeout: 0,
		});
		// ioredis also emits connection failures; diagnostics contain only the
		// fixed purpose name below, never driver messages or configuration.
		const failure = new Promise<never>((_, reject) => client.on('error', reject));
		try {
			await Promise.race([failure, client.connect()]);
		} finally {
			if (client.status !== 'end') {
				await new Promise<void>(done => {
					client.once('end', done);
					client.disconnect(false);
				});
			}
		}
	};
	const inspect = async (target: string, check: () => Promise<void>) => {
		const result = { target, ready: false };
		checks.push(result);
		try {
			await check();
			result.ready = true;
		} catch {
			// A failed connection or cleanup must fail the command, while other
			// accepted checks still finish and release their own connections.
		}
	};
	const pending = [inspect('database', database)];
	const seen = new Set<RedisConfig>();
	for (const [target, options] of [
		['redis', config.redis],
		['redisForPubsub', config.redisForPubsub],
		['redisForJobQueue', config.redisForJobQueue],
		['redisForTimelines', config.redisForTimelines ?? config.redis],
		['redisForReactions', config.redisForReactions ?? config.redis],
	] as const) {
		if (!seen.has(options)) {
			seen.add(options);
			pending.push(inspect(target, () => redis(options)));
		}
	}
	await Promise.all(pending);
	return { ready: checks.every(check => check.ready), checks };
}
