/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { setTimeout as delay } from 'node:timers/promises';
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
			enableOfflineQueue: false, disconnectTimeout: 0, enableReadyCheck: false,
		});
		const failure = new Promise<never>((_, reject) => client.on('error', reject));
		const cancellation = new AbortController();
		let timer: NodeJS.Timeout;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('Redis readiness deadline exceeded')), timeoutMs);
		});
		const ready = async () => {
			await client.connect();
			if (options.enableReadyCheck === false) {
				// connect() can resolve before automatic AUTH when no client
				// metadata command is queued. Await the same credential check.
				if (client.options.username) {
					await client.auth(client.options.username, client.options.password ?? '');
				} else if (client.options.password) {
					await client.auth(client.options.password);
				}
				return;
			}
			// The library's INFO loop logs raw NOPERM text and retains retry
			// timers after disconnect. Own this loop so one deadline covers it.
			for (;;) {
				let response: string;
				try {
					response = await client.info();
				} catch (error) {
					if (error instanceof Error && error.message.includes('NOPERM')) {
						return;
					}
					throw error;
				}
				const info = Object.fromEntries(response.split('\r\n').map(line => {
					const [name, ...value] = line.split(':');
					return [name, value.join(':')];
				}));
				if (!info.loading || info.loading === '0') {
					return;
				}
				const etaMs = Number(info.loading_eta_seconds || 1) * 1000;
				const maximum = client.options.maxLoadingRetryTime;
				await delay(maximum && maximum < etaMs ? maximum : etaMs, undefined, { signal: cancellation.signal });
			}
		};
		try {
			await Promise.race([failure, deadline, ready()]);
		} finally {
			clearTimeout(timer!);
			cancellation.abort();
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
