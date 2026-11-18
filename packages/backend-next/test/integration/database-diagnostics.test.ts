/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiMeta } from 'backend-upstream/entities';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase, testConfig } from '../helpers/database.js';
import { createPinnedDiagnosticSource } from '../helpers/pinned-database-diagnostics.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
});
afterAll(async () => {
	await database?.close();
});

for (const environment of ['development', 'production']) {
	describe(environment, () => {
		test('pinned source reports a real query above 300ms and keeps a short query quiet', async () => {
			const warnings: unknown[] = [];
			const source = createPinnedDiagnosticSource(database.config, { environment, sink: {
				info() {}, error() {}, warn: (query, parameters) => {
					warnings.push({ query, parameters });
				},
			} });
			vi.spyOn(console, 'log').mockImplementation((...args) => {
				warnings.push(args);
			});
			try {
				await source.initialize();
				warnings.length = 0;
				await source.query('SELECT 1 AS value');
				expect(warnings).toEqual([]);
				await source.query('SELECT pg_sleep(0.35), $1::text AS value', ['diagnostic-fixture-value']);
				expect(warnings.length).toBeGreaterThan(0);
				expect(JSON.stringify(warnings)).toContain('pg_sleep');
				expect(JSON.stringify(warnings).includes('diagnostic-fixture-value')).toBe(environment === 'production');
			} finally {
				if (source.isInitialized) {
					await source.destroy();
				}
			}
		});

		test('next emits structured duration/routing and no query values even for production', async () => {
			const lines: string[] = [];
			vi.stubEnv('NODE_ENV', environment);
			const source = createDataSource(database.config.database, 30000, createLogger('database-diagnostics-test', line => lines.push(line)));
			try {
				await source.initialize();
				lines.length = 0;
				expect(await source.query('SELECT 1 AS value')).toEqual([{ value: 1 }]);
				expect(lines).toEqual([]);
				const query = 'SELECT pg_sleep(0.35), $1::text AS private_content';
				expect(await source.query(query, ['private-value'])).toEqual([{ pg_sleep: '', private_content: 'private-value' }]);
				expect(lines).toHaveLength(1);
				const event = JSON.parse(lines[0]);
				expect(event).toMatchObject({ level: 'warn', event: 'db.query-slow', process: 'database-diagnostics-test', requestedReplicationMode: 'master' });
				expect(event.durationMs).toBeGreaterThan(300);
				expect(Object.keys(event).sort()).toEqual(['durationMs', 'event', 'level', 'pid', 'process', 'requestedReplicationMode', 'timestamp']);
				await expect(source.query('SELECT missing_diagnostic_column')).rejects.toMatchObject({ driverError: { code: '42703' } });
				expect(lines).toHaveLength(1);
			} finally {
				if (source.isInitialized) {
					await source.destroy();
				}
			}
		});
	});
}

test('diagnostic failure does not reject an already executed write', async () => {
	const warnings: unknown[] = [];
	const source = createDataSource(database.config.database, 30000, {
		info() {}, error() {}, warn: (event, fields) => {
			warnings.push({ event, ...fields });
			throw new Error('diagnostic sink rejected');
		},
	});
	try {
		await source.initialize();
		await source.query('CREATE TABLE diagnostic_write (value integer)');
		warnings.length = 0;
		await expect(source.query('INSERT INTO diagnostic_write SELECT 1 FROM pg_sleep(0.35)')).resolves.toBeDefined();
		expect(warnings).toEqual([expect.objectContaining({ event: 'db.query-slow', durationMs: expect.any(Number) })]);
		expect(await source.query('SELECT value FROM diagnostic_write')).toEqual([{ value: 1 }]);
	} finally {
		if (source.isInitialized) {
			await source.destroy();
		}
	}
});

test.each([
	['production', false, true], ['development', false, true], ['production', true, false], ['test', false, false],
] as const)('pinned cache activation for %s disableCache=%s is %s; next leaves unused query caching absent', (environment, disableCache, enabled) => {
	const config = testConfig();
	const source = createPinnedDiagnosticSource(config, { environment, disableCache, sink: { info() {}, warn() {}, error() {} } });
	if (enabled) {
		expect(source.options.cache).toMatchObject({ type: 'ioredis', options: { keyPrefix: `${config.redis.prefix}:query:` } });
	} else {
		expect(source.options.cache).toBe(false);
	}
	expect(createDataSource(config.database).options.cache).toBeUndefined();
});

test('normal resource startup uses its process logger and releases the database after diagnostics', async () => {
	const lines: string[] = [];
	const resources = await connectResources(database.config, createLogger('diagnostic-process', line => lines.push(line)));
	try {
		lines.length = 0;
		await resources.dataSource.query('SELECT pg_sleep(0.35)');
		expect(lines.map(line => JSON.parse(line))).toEqual([
			expect.objectContaining({ event: 'db.query-slow', process: 'diagnostic-process', durationMs: expect.any(Number) }),
		]);
	} finally {
		await resources.close();
	}
	expect(resources.dataSource.isInitialized).toBe(false);
});

test('pinned cache uses the query prefix, retains an explicitly cached count, and closes its Redis connection', async () => {
	const redis = new Redis({ ...database.config.redis, keyPrefix: '', lazyConnect: true });
	const connectionName = `diagnostic-cache-${database.config.database.database}`;
	const cacheConfig = { ...database.config, redis: { ...database.config.redis, connectionName } };
	const source = createPinnedDiagnosticSource(cacheConfig, { environment: 'production', disableCache: false, sink: { info() {}, warn() {}, error() {} } });
	try {
		await redis.connect();
		await source.initialize();
		await source.getRepository(MiMeta).deleteAll();
		expect(await source.getRepository(MiMeta).count({ cache: 3600000 })).toBe(0);
		await source.getRepository(MiMeta).insert({ id: 'cache-fixture' });
		expect(await source.getRepository(MiMeta).count({ cache: 3600000 })).toBe(0);
		expect(await source.getRepository(MiMeta).count()).toBe(1);
		const keys = await redis.keys(`${database.config.redis.prefix}:query:*`);
		expect(keys).toHaveLength(1);
		expect(await redis.pttl(keys[0])).toBeGreaterThan(3500000);
		const clients = (await redis.client('LIST') as string).trim().split('\n').map(line => Object.fromEntries(line.split(' ').map(field => field.split('='))));
		const cacheClients = clients.filter(client => client.name === connectionName);
		expect(cacheClients).toHaveLength(1);
		const clientId = cacheClients[0].id;
		await source.destroy();
		expect((await redis.client('LIST') as string).split('\n').some(line => line.startsWith(`id=${clientId} `))).toBe(false);
		await redis.del(...keys);
	} finally {
		try {
			if (source.isInitialized) {
				await source.destroy();
			}
		} finally {
			await redis.quit();
		}
	}
});

test('ORM reads without replicas report the requested slave mode rather than claiming a replica connection', async () => {
	const lines: string[] = [];
	const source = createDataSource(database.config.database, 30000, createLogger('diagnostic-orm-mode', line => lines.push(line)));
	try {
		await source.initialize();
		expect(source.options).not.toHaveProperty('replication');
		await source.getRepository(MiMeta).save({ id: 'diagnostic-orm-mode' });
		lines.length = 0;
		await source.getRepository(MiMeta).createQueryBuilder('meta').select('pg_sleep(0.35)', 'wait').limit(1).getRawMany();
		expect(lines.map(line => JSON.parse(line))).toEqual([
			expect.objectContaining({ event: 'db.query-slow', requestedReplicationMode: 'slave' }),
		]);
	} finally {
		if (source.isInitialized) {
			await source.destroy();
		}
	}
});

test('a query that exceeds the slow threshold but fails with statement_timeout does not emit a successful-query diagnostic', async () => {
	const lines: string[] = [];
	const source = createDataSource({ ...database.config.database, extra: { statement_timeout: 350 } }, 30000, createLogger('diagnostic-timeout', line => lines.push(line)));
	try {
		await source.initialize();
		lines.length = 0;
		await expect(source.query('SELECT pg_sleep(0.6)')).rejects.toMatchObject({ driverError: { code: '57014' } });
		expect(lines).toEqual([]);
	} finally {
		if (source.isInitialized) {
			await source.destroy();
		}
	}
});
