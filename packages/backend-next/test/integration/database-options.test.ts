/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dump } from 'js-yaml';
import { MiMeta } from 'backend-upstream/entities';
import { IsNull, type DataSource, type FindOptionsWhere } from 'typeorm';
import { loadConfig } from '../../src/config/load-config.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createLogger } from '../../src/platform/logger.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { readMeta } from '../../src/platform/database/meta.js';
import { createTransactionRunner } from '../../src/platform/database/transaction-runner.js';
import { createTestDatabase } from '../helpers/database.js';
import { createPinnedDatabaseSource } from '../helpers/pinned-database-source.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
});
afterAll(async () => {
	await database?.close();
});

for (const [name, create] of [['next', createDataSource], ['pinned-source', createPinnedDatabaseSource]] as const) {
	describe(name, () => {
		let source: DataSource;
		beforeAll(async () => {
			source = await create(database.config.database).initialize();
		});
		afterAll(async () => {
			await source?.destroy();
		});

		test('default statement timeout cancels a real slow query at ten seconds and the connection remains usable', async () => {
			expect(await source.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '10s' }]);
			await expect(source.query('SELECT pg_sleep(10.1)')).rejects.toMatchObject({ driverError: { code: '57014' } });
			expect(await source.query('SELECT 42 AS value')).toEqual([{ value: 42 }]);
		});

		test.each([0, 25])('db.extra overrides the server statement timeout to %i milliseconds', async timeout => {
			const override = await create({ ...database.config.database, extra: { statement_timeout: timeout, application_name: 'database-options-probe' } }).initialize();
			try {
				expect(await override.query('SHOW statement_timeout')).toEqual([{ statement_timeout: timeout === 0 ? '0' : '25ms' }]);
				expect(await override.query('SHOW application_name')).toEqual([{ application_name: 'database-options-probe' }]);
				if (timeout === 0) {
					await expect(override.query('SELECT pg_sleep(0.05)')).resolves.toHaveLength(1);
				} else {
					await expect(override.query('SELECT pg_sleep(0.1)')).rejects.toMatchObject({ driverError: { code: '57014' } });
				}
			} finally {
				await override.destroy();
			}
		});

		test('raw int8, count and the ordinary Meta reader return upstream numbers including unsafe rounding', async () => {
			expect(await source.query('SELECT \'-9223372036854775808\'::int8 AS min, \'9223372036854775807\'::int8 AS max, \'9007199254740993\'::int8 AS unsafe, ARRAY[1,9007199254740993]::int8[] AS values'))
				.toEqual([{ min: Number('-9223372036854775808'), max: Number('9223372036854775807'), unsafe: 9007199254740992, values: ['1', '9007199254740993'] }]);
			await source.getRepository(MiMeta).deleteAll();
			await source.getRepository(MiMeta).insert({ id: 'x', urlPreviewMaximumContentLength: 10485760 });
			expect((await readMeta(source.manager)).urlPreviewMaximumContentLength).toBe(10485760);
			expect(await source.query('SELECT count(*) AS count FROM meta')).toEqual([{ count: 1 }]);
		});

		test.each([null, undefined])('nullish WHERE value %s is ignored for reads and anchored updates; IsNull remains explicit', async value => {
			const metas = source.getRepository(MiMeta);
			await metas.deleteAll();
			await metas.insert([{ id: 'a', name: 'named' }, { id: 'b', name: null }]);
			// ORM types forbid null, but existing JavaScript callers and decoded input can supply it.
			const condition = { name: value } as unknown as FindOptionsWhere<MiMeta>;
			expect((await metas.find({ where: condition, order: { id: 'ASC' } })).map(row => row.id)).toEqual(['a', 'b']);
			expect((await metas.findBy({ name: IsNull() })).map(row => row.id)).toEqual(['b']);
			await metas.update({ id: 'a', ...condition }, { name: 'updated' });
			expect((await metas.find({ order: { id: 'ASC' } })).map(row => [row.id, row.name])).toEqual([['a', 'updated'], ['b', null]]);
		});

		test('timeout after an insert rejects the transaction and restores its rows before another transaction succeeds', async () => {
			const timed = await create({ ...database.config.database, extra: { statement_timeout: 25 } }).initialize();
			try {
				await source.getRepository(MiMeta).deleteAll();
				const runner = createTransactionRunner(timed, manager => ({
					append: (id: string) => manager.getRepository(MiMeta).insert({ id }),
					wait: () => manager.query('SELECT pg_sleep(0.1)'),
				}));
				await expect(runner.run(async tx => {
					await tx.append('rollback');
					await tx.wait();
					return 'saved';
				}))
					.rejects.toMatchObject({ driverError: { code: '57014' } });
				expect(await source.getRepository(MiMeta).find()).toEqual([]);
				await runner.run(tx => tx.append('committed'));
				expect((await source.getRepository(MiMeta).find()).map(row => row.id)).toEqual(['committed']);
			} finally {
				await timed.destroy();
			}
		});

		test('authentication failure rejects initialization and leaves the source unavailable', async () => {
			const broken = create({ ...database.config.database, password: 'deliberately-invalid' });
			await expect(broken.initialize()).rejects.toMatchObject({ code: '28P01' });
			expect(broken.isInitialized).toBe(false);
		});
	});
}

test.each([undefined, 250])('normal YAML startup applies timeout %s and supplies a numeric bigint to the shared Meta consumer', async timeout => {
	const directory = await mkdtemp(join(tmpdir(), 'database-options-'));
	let resources: Awaited<ReturnType<typeof connectResources>> | undefined;
	try {
		const { database: db, redis } = database.config;
		const configFile = join(directory, 'test.yml');
		await writeFile(configFile, dump({
			url: 'https://example.test', port: 3000,
			db: { host: db.host, port: db.port, user: db.username, pass: db.password, db: db.database, extra: timeout === undefined ? {} : { statement_timeout: timeout } },
			redis: { host: redis.host, port: redis.port, prefix: redis.prefix },
		}));
		const config = await loadConfig({ configFile, env: {} });
		resources = await connectResources(config, createLogger('database-options-test', () => {}));
		expect(await resources.dataSource.query('SHOW statement_timeout')).toEqual([{ statement_timeout: timeout === undefined ? '10s' : '250ms' }]);
		await resources.dataSource.getRepository(MiMeta).deleteAll();
		await resources.dataSource.getRepository(MiMeta).insert({ id: 'x', urlPreviewMaximumContentLength: 10485760 });
		expect((await resources.meta.fetch(true)).urlPreviewMaximumContentLength).toBe(10485760);
	} finally {
		await resources?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
