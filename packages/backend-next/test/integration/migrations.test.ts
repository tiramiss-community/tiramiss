/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database?.close();
});
test('rejects an empty database without creating any history or schema', async () => {
	await expect(assertMigrationsApplied(database.config.database)).rejects.toThrow();
	const source = await createDataSource(database.config.database).initialize();
	expect(
		await source.query(
			"SELECT to_regclass('public.migrations') AS upstream, to_regclass('backend_internal.migrations') AS internal",
		),
	).toEqual([{ upstream: null, internal: null }]);
	await source.destroy();
});
test('applies all upstream migrations once and keeps internal history separate', async () => {
	await migrateDatabase(database.config.database);
	await assertMigrationsApplied(database.config.database);
	const source = await createDataSource(database.config.database).initialize();
	const before = await source.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id');
	expect(before).toHaveLength(349);
	expect(await source.query('SELECT * FROM backend_internal.migrations')).toEqual([]);
	// A second command must preserve upstream migration IDs, not replay history.
	await migrateDatabase(database.config.database);
	expect(await source.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id')).toEqual(before);
	expect(await source.query("SELECT to_regclass('public.note') AS note")).toEqual([{ note: 'note' }]);
	await source.destroy();
});
test('checks only copied entity scope and reports real schema drift without applying DDL', async () => {
	await assertSchemaMatches(database.config.database);
	const source = await createDataSource(database.config.database).initialize();
	await source.query('ALTER TABLE public.role ADD COLUMN "unexpectedFoundationColumn" text');
	await expect(assertSchemaMatches(database.config.database)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
	expect(
		await source.query(
			"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='role' AND column_name='unexpectedFoundationColumn'",
		),
	).toHaveLength(1);
	await source.query('ALTER TABLE public.role DROP COLUMN "unexpectedFoundationColumn"');
	await source.destroy();
});
test('rejects missing internal history without recreating it', async () => {
	const source = await createDataSource(database.config.database).initialize();
	await source.query('DROP TABLE backend_internal.migrations');
	await expect(assertMigrationsApplied(database.config.database)).rejects.toThrow();
	expect(await source.query("SELECT to_regclass('backend_internal.migrations') AS name")).toEqual([{ name: null }]);
	await source.destroy();
});

test('does not change public schema when initializing only internal history', async () => {
	const source = await createDataSource(database.config.database).initialize();
	const snapshot = () =>
		source.query(
			"SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position",
		);
	const before = await snapshot();
	await source.query('DROP SCHEMA backend_internal CASCADE');
	await migrateDatabase(database.config.database);
	expect(await snapshot()).toEqual(before);
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	await source.destroy();
});
test('does not initialize internal state after upstream migration failure', async () => {
	const broken = await createTestDatabase();
	const source = await createDataSource(broken.config.database).initialize();
	try {
		await source.query('CREATE TABLE public.instance (existing_column integer)');
		await expect(migrateDatabase(broken.config.database)).rejects.toThrow();
		expect(await source.query("SELECT to_regnamespace('backend_internal') AS name")).toEqual([{ name: null }]);
	} finally {
		await source.destroy();
		await broken.close();
	}
});
