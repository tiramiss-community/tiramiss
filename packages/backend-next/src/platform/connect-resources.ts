/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import { openRoleMaterials } from './role-materials.js';
import { createRoleMaterialReader } from './database/role-materials.js';
import { ResourceScope } from './resource-scope.js';
import { DiagnosticError } from './diagnostic-error.js';
import { createDataSource } from './database/data-source.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Logger } from './logger.js';

export async function connectResources(config: RuntimeConfig, logger: Logger) {
	const scope = new ResourceScope();
	let cancelled = false;
	let active = false;
	let reportFailure!: (error: Error) => void;
	const failure = new Promise<Error>(resolve => {
		reportFailure = resolve;
	});
	let closing = false;
	const close = () => {
		closing = true;
		return scope.close();
	};
	let timer: NodeJS.Timeout | undefined;
	const timeout = new DiagnosticError('STARTUP_TIMEOUT', { timeoutMs: config.processes.startupTimeoutMs });

	const initialize = async () => {
		const dataSource = createDataSource(config.database, config.processes.startupTimeoutMs);
		scope.defer(async () => {
			if (dataSource.isInitialized) {
				await dataSource.destroy();
			}
		});

		try {
			await dataSource.initialize();
		} finally {
			// Promise.race は接続作成を中断しない。期限後に完成したプールもここで解放する必要がある。
			if (cancelled && dataSource.isInitialized) {
				await dataSource.destroy();
			}
		}
		if (cancelled) {
			throw timeout;
		}

		const redis = new Redis({
			...config.redis,
			lazyConnect: true,
			connectTimeout: config.processes.startupTimeoutMs,
			// Redis は必須なので、再接続で起動失敗を先送りせず運用側へ失敗を返す。
			retryStrategy: () => null,
			maxRetriesPerRequest: 0,
			disconnectTimeout: 0,
		});
		redis.on('error', (error) => {
			logger.error('redis.error', { error });
		});
		scope.defer(async () => {
			if (redis.status === 'end') {
				return;
			}
			await new Promise<void>((resolve) => {
				redis.once('end', resolve);
				redis.disconnect();
			});
		});

		await redis.connect();
		if (cancelled) {
			throw timeout;
		}
		await redis.ping();
		if (cancelled) {
			throw timeout;
		}

		const rolePublisher = new Redis({
			...config.redisForPubsub,
			disconnectTimeout: 0,
			lazyConnect: true,
			enableOfflineQueue: false,
			connectTimeout: config.processes.startupTimeoutMs,
			retryStrategy: () => null,
			maxRetriesPerRequest: 0,
		});
		rolePublisher.on('error', error => logger.error('role-pubsub.error', { error }));
		rolePublisher.on('end', () => {
			if (active && !closing) {
				// 再接続しない必須接続を失った子を残すと、Supervisorは障害を検知できない。
				reportFailure(new DiagnosticError('ROLE_PUBLISHER_ENDED', {}));
			}
		});
		scope.defer(async () => {
			if (rolePublisher.status !== 'end') {
				await new Promise<void>(resolve => {
					rolePublisher.once('end', resolve);
					rolePublisher.disconnect();
				});
			}
		});
		await rolePublisher.connect();
		await rolePublisher.ping();
		if (cancelled) {
			throw timeout;
		}

		const roleMaterials = await openRoleMaterials({
			source: createRoleMaterialReader(dataSource.manager),
			publisher: rolePublisher,
			subscriberConfig: { ...config.redisForPubsub, connectTimeout: config.processes.startupTimeoutMs },
			config: config.roleCache,
			registerCleanup: cleanup => scope.defer(cleanup),
		});
		if (cancelled) {
			await roleMaterials.close();
			throw timeout;
		}

		active = true;
		return { dataSource, redis, roleMaterials, logger, close, failure };
	};

	try {
		// Redis の connectTimeout は TCP 接続後の応答待ちを覆わないため、それだけには頼らない。
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
			await close();
		} catch (cleanupError) {
			logger.error('cleanup.failed', { error: cleanupError });
		}

		throw error;
	} finally {
		clearTimeout(timer);
	}
}
