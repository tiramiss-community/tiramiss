/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { createDisposableRedis } from '../helpers/disposable-redis.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let disposableRedis: ReturnType<typeof createDisposableRedis>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let port: number;
let otherRedis: Redis;
let pubsubRedis: Redis;
const notifications: { type: string; body: { after: { name: string | null } } }[] = [];
let histories: unknown[];
const post = (name: string, input: unknown = {}) => fetch(`http://127.0.0.1:${port}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
const bind = () => vi.stubEnv('BACKEND_NEXT_TEST_RESET_TARGET', JSON.stringify({
	database: { host: database.config.database.host, port: database.config.database.port, database: database.config.database.database },
	redis: { host: database.config.redis.host, port: database.config.redis.port, db: database.config.redis.db ?? 0 },
}));
const stored = () => resources.dataSource.query('SELECT * FROM ONLY public.reset_sentinel');
const history = () => resources.dataSource.query('SELECT \'public\' AS schema, * FROM public.migrations UNION ALL SELECT \'backend_internal\' AS schema, * FROM backend_internal.migrations ORDER BY schema, id');

beforeAll(async () => {
	database = await createTestDatabase();
	disposableRedis = createDisposableRedis();
	Object.assign(database.config.redis, { host: disposableRedis.host, port: disposableRedis.port });
	database.config.redisForPubsub = { ...database.config.redis, db: 2 };
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('test-controls-test', () => {}));
	await resources.dataSource.query('CREATE TABLE public.reset_sentinel (id integer PRIMARY KEY)');
	await resources.dataSource.query('CREATE TABLE backend_internal.reset_sentinel (id integer PRIMARY KEY)');
	await resources.dataSource.query('CREATE SCHEMA unrelated');
	await resources.dataSource.query('CREATE TABLE unrelated.keep (id integer PRIMARY KEY)');
	await resources.dataSource.query('INSERT INTO unrelated.keep VALUES (1)');
	await resources.dataSource.query('CREATE TABLE unrelated.inherited () INHERITS (public.reset_sentinel)');
	await resources.dataSource.query('INSERT INTO unrelated.inherited VALUES (99)');
	histories = await history();
	otherRedis = new Redis({ ...database.config.redis, db: 1, keyPrefix: undefined });
	await otherRedis.set(`${database.config.redis.prefix}:reset-unrelated-db`, 'retained');
	pubsubRedis = new Redis({ ...database.config.redisForPubsub, keyPrefix: undefined });
	await pubsubRedis.set(`${database.config.redis.prefix}:pubsub-retained`, 'retained');
	pubsubRedis.on('message', (_topic, payload) => {
		const event = JSON.parse(payload);
		if (event.channel === 'internal') {
			notifications.push(event.message);
		}
	});
	await pubsubRedis.subscribe(new URL(database.config.url).host);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	port = (server.address() as { port: number }).port;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
	try {
		if (server) {
			await closeHttp(server);
		}
	} finally {
		otherRedis?.disconnect();
		pubsubRedis?.disconnect();
		try {
			await resources?.close();
		} finally {
			try {
				await database?.close();
			} finally {
				disposableRedis?.close();
			}
		}
	}
});

test('normal HTTP input validation works and production reset leaves PostgreSQL and Redis untouched', async () => {
	vi.stubEnv('NODE_ENV', 'production');
	bind();
	await resources.dataSource.query('INSERT INTO public.reset_sentinel VALUES (1)');
	await resources.dataSource.query('INSERT INTO backend_internal.reset_sentinel VALUES (1)');
	await resources.redis.set('reset-sentinel', 'retained');
	const valid = await post('test', { required: false });
	expect(valid.status).toBe(200);
	expect(await valid.json()).toEqual({ required: false, default: 'hello', nullableDefault: 'hello' });
	const response = await post('reset-db');
	expect(response.status).toBe(500);
	expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
	expect(await stored()).toEqual([{ id: 1 }]);
	expect(await resources.redis.get('reset-sentinel')).toBe('retained');
});

test('NODE_ENV=test alone and stale target bindings cannot flush the configured storage', async () => {
	vi.stubEnv('NODE_ENV', 'test');
	for (const target of ['', JSON.stringify({ database: {}, redis: {} })]) {
		vi.stubEnv('BACKEND_NEXT_TEST_RESET_TARGET', target);
		expect((await post('reset-db')).status).toBe(500);
		expect(await stored()).toEqual([{ id: 1 }]);
		expect(await resources.redis.get('reset-sentinel')).toBe('retained');
	}
});

test('reset clears both runtime schemas, preserves histories and other storage, refreshes Meta and permits the next operation', async () => {
	vi.stubEnv('NODE_ENV', 'test');
	bind();
	await resources.meta.fetch(true);
	await resources.dataSource.query('UPDATE meta SET name = \'before-reset\'');
	expect((await resources.meta.fetch(true)).name).toBe('before-reset');
	const response = await post('reset-db');
	expect(response.status).toBe(204);
	expect(await response.text()).toBe('');
	expect(await stored()).toEqual([]);
	expect(await resources.dataSource.query('SELECT * FROM backend_internal.reset_sentinel')).toEqual([]);
	expect(await history()).toEqual(histories);
	expect(await resources.dataSource.query('SELECT * FROM unrelated.keep')).toEqual([{ id: 1 }]);
	expect(await resources.dataSource.query('SELECT * FROM unrelated.inherited')).toEqual([{ id: 99 }]);
	expect(await resources.redis.get('reset-sentinel')).toBe(null);
	expect(await otherRedis.get(`${database.config.redis.prefix}:reset-unrelated-db`)).toBe('retained');
	const pubsubData = otherRedis.duplicate({ db: 2 });
	try {
		expect(await pubsubData.get(`${database.config.redis.prefix}:pubsub-retained`)).toBe('retained');
	} finally {
		pubsubData.disconnect();
	}
	expect((await resources.meta.fetch()).name).toBe(null);
	expect(notifications.some(event => event.type === 'metaUpdated' && event.body.after.name === null)).toBe(true);
	await resources.dataSource.query('INSERT INTO public.reset_sentinel VALUES (2)');
	expect(await stored()).toEqual([{ id: 2 }]);
	expect((await post('test', { required: true, string: 'after reset' })).status).toBe(200);
});

test('cross-schema references fail atomically without CASCADE after the upstream-ordered Redis flush; retry recovers', async () => {
	vi.stubEnv('NODE_ENV', 'test');
	bind();
	await resources.dataSource.query('CREATE TABLE unrelated.reference (id integer REFERENCES public.reset_sentinel(id))');
	await resources.dataSource.query('INSERT INTO unrelated.reference VALUES (2)');
	await resources.redis.set('reset-sentinel', 'will be cleared');
	expect((await post('reset-db')).status).toBe(500);
	expect(await stored()).toEqual([{ id: 2 }]);
	expect(await resources.dataSource.query('SELECT * FROM unrelated.reference')).toEqual([{ id: 2 }]);
	expect(await history()).toEqual(histories);
	expect(await resources.redis.get('reset-sentinel')).toBe(null);
	await resources.dataSource.query('DROP TABLE unrelated.reference');
	expect((await post('reset-db')).status).toBe(204);
	expect(await stored()).toEqual([]);
});

test('Redis failure stops before database reset', async () => {
	vi.stubEnv('NODE_ENV', 'test');
	bind();
	await resources.dataSource.query('INSERT INTO public.reset_sentinel VALUES (3)');
	resources.redis.disconnect();
	expect((await post('reset-db')).status).toBe(500);
	expect(await stored()).toEqual([{ id: 3 }]);
	expect(await history()).toEqual(histories);
});
