/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let control: DataSource;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	control = await createDataSource(database.config.database).initialize();
});
afterAll(async () => {
	await control?.destroy();
	await database?.close();
});

test('an explicit startup Meta consumer fails without ready and releases real DB/Redis connections', async () => {
	const { Redis } = await import('ioredis');
	const connectionName = database.config.database.database;
	const config = await configuration({
		...database.config,
		http: { port: await freePort() },
		redis: { ...database.config.redis, connectionName },
		redisForPubsub: { ...database.config.redisForPubsub, connectionName },
		redisForJobQueue: { ...database.config.redisForJobQueue, connectionName },
	});
	const redis = new Redis(database.config.redis);
	await control.query('ALTER TABLE "meta" RENAME TO "meta_startup_fault"');
	const child = launch('test/fixtures/meta-startup.mjs', config.path);
	try {
		expect((await child.exit).code, child.output()).toBe(1);
		expect(child.output()).toContain('startup.failed');
		expect(child.output()).toContain('"code":"42P01"');
		expect(child.output()).not.toContain('process.ready');
		expect(child.messages).not.toContainEqual(expect.objectContaining({ type: 'ready' }));
		expect(await control.query('SELECT pid FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [database.config.database.database])).toEqual([]);
		expect(String(await redis.client('LIST'))).not.toContain(`name=${connectionName} `);
	} finally {
		await child.close();
		await control.query('ALTER TABLE "meta_startup_fault" RENAME TO "meta"');
		redis.disconnect();
		await config.close();
	}
});
