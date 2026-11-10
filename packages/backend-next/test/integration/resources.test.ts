/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createLogger } from '../../src/platform/logger.js';

const runtimeHooks = vi.hoisted(() => ({
	afterReady: undefined as undefined | (() => Promise<void>),
	onError: undefined as undefined | ((event: { reason: string }) => void),
}));
vi.mock('../../src/platform/job-queue/runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/platform/job-queue/runtime.js')>();
	return {
		...actual,
		createBusinessJobRuntime: (options: Parameters<typeof actual.createBusinessJobRuntime>[0]) => {
			const owner = actual.createBusinessJobRuntime({ ...options, onError(event) {
				options.onError(event);
				runtimeHooks.onError?.(event);
			} });
			const ready = owner.runtime.ready.bind(owner.runtime);
			owner.runtime.ready = async (...args) => {
				await ready(...args);
				await runtimeHooks.afterReady?.();
			};
			return owner;
		},
	};
});

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database?.close();
});
const logger = createLogger('test', () => {});
test('connects to real dependencies and closes them idempotently', async () => {
	const resources = await connectResources(database.config, logger);
	expect(await resources.redis.ping()).toBe('PONG');
	expect(await resources.dataSource.query('SELECT 1 AS value')).toEqual([{ value: 1 }]);
	await resources.close();
	await resources.close();
	expect(resources.dataSource.isInitialized).toBe(false);
	expect(resources.redis.status).toBe('end');
});
test('fails fast on an unavailable Redis without retaining database connections', async () => {
	await expect(
		connectResources({ ...database.config, redis: { ...database.config.redis, port: 1 } }, logger),
	).rejects.toThrow();
	const check = await connectResources(database.config, logger);
	const rows = await check.dataSource.query(
		'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
	);
	expect(rows[0].count).toBe(1);
	await check.close();
});
test('fails fast on an unavailable job queue Redis without retaining database connections', async () => {
	await expect(
		connectResources({ ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, port: 1 } }, logger),
	).rejects.toThrow();
	const check = await connectResources(database.config, logger);
	const rows = await check.dataSource.query(
		'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
	);
	expect(rows[0].count).toBe(1);
	await check.close();
});

test('reports loss of the job queue connection and closes it normally without a report', async () => {
	const { Redis } = await import('ioredis');
	const { randomUUID } = await import('node:crypto');
	const connectionName = `job-queue-${randomUUID()}`;
	const control = new Redis(database.config.redis);
	const resources = await connectResources({ ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, connectionName } }, logger);
	try {
		const line = String(await control.client('LIST')).split('\n').find(entry => entry.includes(`name=${connectionName} `));
		expect(line).toBeDefined();
		await control.client('KILL', 'ID', line!.match(/^id=(\d+)/)![1]);
		expect((await resources.failure).message).toContain('JOB_QUEUE_REDIS_ENDED');
	} finally {
		await resources.close();
		control.disconnect();
	}

	const healthy = await connectResources(database.config, logger);
	let reported = false;
	void healthy.failure.then(() => {
		reported = true;
	});
	await healthy.close();
	await new Promise(resolve => setTimeout(resolve, 50));
	expect(reported).toBe(false);
});

test('fails startup on connection loss after producer readiness while later initialization is held', async () => {
	const { Redis } = await import('ioredis');
	const { randomUUID } = await import('node:crypto');
	const connectionName = `job-queue-${randomUUID()}`;
	const control = new Redis(database.config.redis);
	let lossObserved = false;
	runtimeHooks.onError = event => {
		lossObserved ||= event.reason === 'connection-ended';
	};
	runtimeHooks.afterReady = async () => {
		// 3 queue 共通の connectionName で投入口の接続を選び、1本を切断する。
		// client ID の順序と queue の対応は前提にしない。
		const ids = String(await control.client('LIST')).split('\n')
			.filter(line => line.includes(`name=${connectionName} `))
			.map(line => Number(line.match(/^id=(\d+)/)![1]));
		expect(ids).not.toHaveLength(0);
		await control.client('KILL', 'ID', String(Math.min(...ids)));
		await vi.waitFor(() => expect(lossObserved).toBe(true));
	};
	try {
		const outcome = await connectResources({ ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, connectionName } }, logger)
			.then(async (resources) => {
				await resources.close();
				return 'started';
			}, (error: unknown) => error);
		expect(outcome).toMatchObject({
			code: 'JOB_QUEUE_REDIS_ENDED',
			details: { queue: expect.stringMatching(/^(endedPollNotification|deliver|userWebhookDeliver)$/) },
		});
	} finally {
		runtimeHooks.afterReady = undefined;
		runtimeHooks.onError = undefined;
		control.disconnect();
	}

	const check = await connectResources(database.config, logger);
	const rows = await check.dataSource.query(
		'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
	);
	expect(rows[0].count).toBe(1);
	await check.close();
});

test('fails on unavailable database before opening Redis', async () => {
	await expect(
		connectResources({ ...database.config, database: { ...database.config.database, port: 1 } }, logger),
	).rejects.toThrow();
});

test.each(['redis', 'redisForPubsub', 'redisForReactions', 'redisForTimelines', 'redisForJobQueue'] as const)('rejects and cleans up before startup deadline when %s accepts TCP but never responds', async redisField => {
	const sockets = new Set<import('node:net').Socket>();
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		socket.resume();
		sockets.add(socket);
		socket.on('close', () => {
			sockets.delete(socket);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const config = {
		...database.config,
		processes: { ...database.config.processes, startupTimeoutMs: 100 },
		[redisField]: { ...(database.config[redisField] ?? database.config.redis), port: (server.address() as { port: number }).port },
	};
	const attempt = connectResources(config, logger);
	let result: 'pending' | 'resolved' | 'rejected' = 'pending';
	void attempt.then(
		async (value) => {
			result = 'resolved';
			await value.close();
		},
		() => {
			result = 'rejected';
		},
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(result).toBe('rejected');
		// 相手側はFIN後も意図的に半開きを保つ。クライアントの解放期限を検証する。
		const check = await connectResources(database.config, logger);
		expect(
			(
				await check.dataSource.query(
					'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
				)
			)[0].count,
		).toBe(1);
		await check.close();
	} finally {
		for (const socket of sockets) {
			socket.destroy();
		}
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		await attempt.catch(() => {});
	}
});

test('dedicated timeline Redis reports loss and closes normally without reporting failure', async () => {
	const resources = await connectResources({ ...database.config, redisForTimelines: { ...database.config.redis, db: 6, keyPrefix: 'timeline174-resources:' } }, logger);
	try {
		expect(await resources.timelinesRedis.ping()).toBe('PONG');
		resources.timelinesRedis.disconnect();
		expect((await resources.failure).message).toContain('TIMELINES_REDIS_ENDED');
	} finally {
		await resources.close();
	}
	expect(resources.timelinesRedis.status).toBe('end');
	expect(resources.redis.status).toBe('end');
	expect(resources.dataSource.isInitialized).toBe(false);
	const healthy = await connectResources({ ...database.config, redisForTimelines: { ...database.config.redis, db: 6 } }, logger);
	let reported = false;
	void healthy.failure.then(() => {
		reported = true;
	});
	await healthy.close();
	await new Promise(resolve => setTimeout(resolve, 20));
	expect(reported).toBe(false);
});

test('startup rejects loss of the timeline connection while later resources are opening', async () => {
	const { Redis } = await import('ioredis');
	const { randomUUID } = await import('node:crypto');
	const connectionName = `timeline174-${randomUUID()}`;
	const control = new Redis(database.config.redis);
	runtimeHooks.afterReady = async () => {
		const line = String(await control.client('LIST')).split('\n').find(entry => entry.includes(`name=${connectionName} `));
		expect(line).toBeDefined();
		await control.client('KILL', 'ID', line!.match(/^id=(\d+)/)![1]);
		await new Promise(resolve => setTimeout(resolve, 50));
	};
	try {
		const result = await connectResources({ ...database.config, redisForTimelines: { ...database.config.redis, connectionName } }, logger).then(async value => {
			await value.close();
			return 'started';
		}, (error: unknown) => error);
		expect(result).toMatchObject({ code: 'TIMELINES_REDIS_ENDED' });
	} finally {
		runtimeHooks.afterReady = undefined;
		runtimeHooks.onError = undefined;
		control.disconnect();
	}
});

test('publishes role notifications through the dedicated pubsub connection', async () => {
	const resources = await connectResources(database.config, logger);
	const primaryPublish = vi.spyOn(resources.redis, 'publish').mockRejectedValue(new Error('primary Redis is not the pubsub transport'));
	try {
		await resources.roleMaterials.changes.publish({ kind: 'role-definitions-changed', roleId: 'test' });
		expect(primaryPublish).not.toHaveBeenCalled();
	} finally {
		await resources.close();
	}
});

test('dedicated reaction Redis uses its configured namespace, reports loss, and closes all connections', async () => {
	const resources = await connectResources({ ...database.config,
																																												redisForReactions: { ...database.config.redis, db: 1, keyPrefix: 'note168-reactions:' } }, logger);
	try {
		await resources.reactionsRedis.set('probe', 'dedicated');
		expect(await resources.redis.get('probe')).toBeNull();
		expect(await resources.reactionsRedis.get('probe')).toBe('dedicated');
		await resources.reactionsRedis.del('probe');
		resources.reactionsRedis.disconnect();
		expect((await resources.failure).message).toContain('REACTIONS_REDIS_ENDED');
	} finally {
		await resources.close();
	}
	expect(resources.reactionsRedis.status).toBe('end');
	expect(resources.redis.status).toBe('end');
	expect(resources.dataSource.isInitialized).toBe(false);
});
