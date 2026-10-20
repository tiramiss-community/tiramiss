/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../src/config/types.js';
export function testConfig(): RuntimeConfig {
	const redis = {
		host: '127.0.0.1',
		port: Number(process.env.BACKEND_NEXT_TEST_REDIS_PORT ?? 56379),
		db: 0,
		prefix: 'backend-next-test',
		keyPrefix: 'backend-next-test:',
	};
	return {
		url: 'http://example.test',
		roleCache: { rolesTtlMs: 30000, assignmentsTtlMs: 30000, assignmentsMaxEntries: 10000 },
		database: {
			host: '127.0.0.1',
			port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432),
			database: 'backend_next_test',
			username: 'postgres',
			password: 'foundation-test-only',
			extra: {},
		},
		redis,
		redisForJobQueue: redis,
		redisForPubsub: redis,
		http: { port: 0 },
		processes: { workerCount: 1, startupTimeoutMs: 10000, shutdownTimeoutMs: 1000 },
	};
}
export async function createTestDatabase() {
	const config = testConfig();
	const name = `backend_next_${randomUUID().replaceAll('-', '')}`;
	const admin = new DataSource({ type: 'postgres', ...config.database });
	await admin.initialize();
	await admin.query(`CREATE DATABASE "${name}"`);
	config.database.database = name;
	return {
		config,
		async close() {
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.destroy();
		},
	};
}
