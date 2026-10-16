/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import { ResourceScope } from './resource-scope.js';
import { DiagnosticError } from './diagnostic-error.js';
import { createDataSource } from './database/data-source.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Logger } from './logger.js';
export async function connectResources(config: RuntimeConfig, logger: Logger) {
	const scope = new ResourceScope();
	let cancelled = false;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new DiagnosticError('STARTUP_TIMEOUT', { timeoutMs: config.processes.startupTimeoutMs });
	const initialize = async () => {
		const dataSource = createDataSource(config.database, config.processes.startupTimeoutMs);
		scope.defer(async () => {
			if (dataSource.isInitialized) await dataSource.destroy();
		});
		try {
			await dataSource.initialize();
		} finally {
			// If initialization settles after the deadline, don't leave a late pool alive.
			if (cancelled && dataSource.isInitialized) await dataSource.destroy();
		}
		if (cancelled) throw timeout;
		const redis = new Redis({
			...config.redis,
			lazyConnect: true,
			connectTimeout: config.processes.startupTimeoutMs,
			retryStrategy: () => null,
			maxRetriesPerRequest: 0,
			disconnectTimeout: 0,
		});
		redis.on('error', (error) => {
			logger.error('redis.error', { error });
		});
		scope.defer(async () => {
			if (redis.status === 'end') return;
			await new Promise<void>((resolve) => {
				redis.once('end', resolve);
				redis.disconnect();
			});
		});
		await redis.connect();
		if (cancelled) throw timeout;
		await redis.ping();
		if (cancelled) throw timeout;
		return { dataSource, redis, logger, close: () => scope.close() };
	};
	try {
		return await Promise.race([
			initialize(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					cancelled = true;
					reject(timeout);
				}, config.processes.startupTimeoutMs);
			}),
		]);
	} catch (error) {
		cancelled = true;
		try {
			await scope.close();
		} catch (cleanupError) {
			logger.error('cleanup.failed', { error: cleanupError });
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
