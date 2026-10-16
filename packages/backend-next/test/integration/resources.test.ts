/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createLogger } from '../../src/platform/logger.js';
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
test('fails on unavailable database before opening Redis', async () => {
	await expect(
		connectResources({ ...database.config, database: { ...database.config.database, port: 1 } }, logger),
	).rejects.toThrow();
});

test('rejects and cleans up before startup deadline when Redis accepts TCP but never responds', async () => {
	const sockets = new Set<import('node:net').Socket>();
	const server = createServer((socket) => {
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
		redis: { ...database.config.redis, port: (server.address() as { port: number }).port },
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
		expect(sockets.size).toBe(0);
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
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		await attempt.catch(() => {});
	}
});
