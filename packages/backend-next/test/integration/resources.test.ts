/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createLogger } from '../../src/platform/logger.js';

const deliverQueueHooks = vi.hoisted(() => ({ beforeReady: undefined as undefined | (() => Promise<void>) }));
vi.mock('../../src/platform/job-queue/deliver.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/platform/job-queue/deliver.js')>();
	return {
		...actual,
		createDeliverQueue: (options: Parameters<typeof actual.createDeliverQueue>[0]) => {
			const queue = actual.createDeliverQueue(options);
			return {
				...queue,
				async ready() {
					await deliverQueueHooks.beforeReady?.();
					await queue.ready();
				},
			};
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

test('fails startup when a job queue connection is lost while later connections are still opening', async () => {
	const { Redis } = await import('ioredis');
	const { randomUUID } = await import('node:crypto');
	const connectionName = `job-queue-${randomUUID()}`;
	const control = new Redis(database.config.redis);
	deliverQueueHooks.beforeReady = async () => {
		// 投入口の Queue は接続に名前を付けないため connectionName で見分ける。先に開いた投票終了の投入口が最小の ID を持つ。
		const ids = String(await control.client('LIST')).split('\n')
			.filter(line => line.includes(`name=${connectionName} `))
			.map(line => Number(line.match(/^id=(\d+)/)![1]));
		expect(ids).not.toHaveLength(0);
		await control.client('KILL', 'ID', String(Math.min(...ids)));
		await new Promise(resolve => setTimeout(resolve, 100));
	};
	try {
		const outcome = await connectResources({ ...database.config, redisForJobQueue: { ...database.config.redisForJobQueue, connectionName } }, logger)
			.then(async (resources) => {
				await resources.close();
				return 'started';
			}, (error: unknown) => error);
		expect(outcome).toMatchObject({ code: 'JOB_QUEUE_REDIS_ENDED', details: { queue: 'endedPollNotification' } });
	} finally {
		deliverQueueHooks.beforeReady = undefined;
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

test.each(['redis', 'redisForPubsub', 'redisForReactions', 'redisForJobQueue'] as const)('rejects and cleans up before startup deadline when %s accepts TCP but never responds', async redisField => {
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
