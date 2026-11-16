/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiMeta } from 'backend-upstream/entities';
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

test.each(['http', 'worker'])('normal %s startup fails without ready and releases real DB/Redis connections when Meta initialization fails', async role => {
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
	const child = launch(`built/entrypoints/${role}.js`, config.path);
	try {
		const outcome = await Promise.race([
			child.ready.then(() => ({ kind: 'ready' })),
			child.exit.then(exit => ({ kind: 'exit', code: exit.code })),
		]);
		expect(outcome, child.output()).toEqual({ kind: 'exit', code: 1 });
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

test.each(['empty', 'existing', 'multiple'])('normal HTTP and worker concurrently initialize %s Meta before ready without overwriting existing rows', async scenario => {
	const repository = control.getRepository(MiMeta);
	await repository.deleteAll();
	if (scenario === 'existing') {
		await repository.insert({ id: 'x', name: 'kept', federation: 'specified', federationHosts: ['kept.example'] });
	}
	if (scenario === 'multiple') {
		await repository.insert([{ id: 'a', name: 'old' }, { id: 'm', name: 'middle' }, { id: 'z', name: 'newest' }]);
	}
	const before = await repository.find({ order: { id: 'ASC' } });
	const configs = await Promise.all(['http', 'worker'].map(async () => configuration({ ...database.config, http: { port: await freePort() } })));
	const children = ['http', 'worker'].map((role, i) => launch(`built/entrypoints/${role}.js`, configs[i].path));
	try {
		await Promise.all(children.map(child => child.ready));
		const after = await repository.find({ order: { id: 'ASC' } });
		if (scenario === 'empty') {
			expect(after).toHaveLength(1);
			expect(after[0]).toMatchObject({ id: 'x', federation: 'none', blockedHosts: [] });
		} else {
			expect(after).toEqual(before);
		}
		for (const child of children) {
			child.child.kill('SIGTERM');
		}
		for (const child of children) {
			expect((await child.exit).code, child.output()).toBe(0);
		}
	} finally {
		await Promise.all(children.map(child => child.close()));
		await Promise.all(configs.map(config => config.close()));
	}
});
