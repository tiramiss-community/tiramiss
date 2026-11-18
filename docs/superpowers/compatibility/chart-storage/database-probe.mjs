/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
require('reflect-metadata');
const { DataSource, EntitySchema } = require('typeorm');
const { migrations } = await import('../../../../packages/backend-upstream/built/exports/migrations.js');
const bytes = readFileSync(new URL('./schema-manifest.json', import.meta.url));
const manifest = JSON.parse(bytes);
const hash = value => createHash('sha256').update(value).digest('hex');
assert(['--write', '--check'].includes(process.argv[2]));
assert(process.env.BACKEND_NEXT_TEST_DB_PORT, 'Explicit dedicated BACKEND_NEXT_TEST_DB_PORT is required');
const options = { type: 'postgres', host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT), username: 'postgres', password: 'foundation-test-only', synchronize: false };
const admin = await new DataSource({ ...options, database: 'backend_next_test' }).initialize();
const database = `backend_next_${randomUUID().replaceAll('-', '')}`;
const definitions = manifest.charts.flatMap(chart => Object.entries(chart.entities).map(([span, entity]) => ({ series: chart.name, span, entity })));
const entities = definitions.map(({ entity }) => new EntitySchema(entity));
const identifier = value => `"${value.replaceAll('"', '""')}"`;
let source;
try {
	await admin.query(`CREATE DATABASE ${identifier(database)}`);
	source = await new DataSource({ ...options, database, migrations, entities }).initialize();
	await source.runMigrations({ transaction: 'all' });
	const history = () => source.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id');
	const historyBefore = await history();
	assert.equal(historyBefore.length, 349);
	const catalog = async () => ({
		columns: await source.query("SELECT table_name, column_name, data_type, udt_name, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name, ordinal_position", [definitions.map(d => d.entity.tableName)]),
		indices: await source.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename, indexname", [definitions.map(d => d.entity.tableName)]),
	});
	const schemaBefore = await catalog();
	const diff = await source.driver.createSchemaBuilder().log();
	assert.deepEqual(diff.upQueries, [], 'generated metadata must match migrated existing tables');
	assert.deepEqual(diff.downQueries, []);
	const fixture = [];
	for (const { series, span, entity } of definitions) {
		const columns = Object.entries(entity.columns).filter(([name]) => name !== 'id');
		const grouped = 'group' in entity.columns;
		const groups = grouped ? ['fixture-user-a', 'fixture-user-b'] : [undefined];
		for (const [index, group] of groups.entries()) {
			const values = columns.map(([name, column]) => name === 'date' ? 1700000000 : name === 'group' ? group : column.array ? ['fixture-old', `fixture-${index}`] : column.type === 'bigint' ? '9007199254740993' : index + 7);
			// Test preparation uses independent SQL against migration-created tables.
			await source.query(`INSERT INTO ${identifier(entity.tableName)} (${columns.map(([name]) => identifier(name)).join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`, values);
		}
		const rows = await source.query(`SELECT * FROM ${identifier(entity.tableName)} ORDER BY id`);
		fixture.push({ series, span, table: entity.tableName, rows });
	}
	// Reopen with only the captured generated metadata, no migration classes or chart services.
	await source.destroy();
	source = await new DataSource({ ...options, database, entities }).initialize();
	const readWrite = [];
	for (const [{ series, span, entity }, historical] of definitions.map((d, i) => [d, fixture[i]])) {
		const repository = source.getRepository(entity.name);
		assert.deepEqual(await repository.find({ order: { id: 'ASC' } }), historical.rows);
		const metric = Object.keys(entity.columns).find(name => name.startsWith('___'));
		const row = historical.rows[0];
		await repository.update({ id: row.id }, { [metric]: 42 });
		const expected = { ...row, [metric]: entity.columns[metric].type === 'bigint' ? '42' : 42 };
		assert.deepEqual(await repository.findOneByOrFail({ id: row.id }), expected);
		if (historical.rows.length > 1) assert.deepEqual(await repository.findOneByOrFail({ id: historical.rows[1].id }), historical.rows[1]);
		// Insert a new period using DB defaults; serial and arrays must keep working.
		await repository.insert({ date: 1700003600, ...(entity.columns.group ? { group: 'fixture-user-a' } : {}) });
		const added = await repository.findOneByOrFail({ date: 1700003600 });
		assert.equal(added.id, historical.rows.length + 1);
		for (const [name, column] of Object.entries(entity.columns).filter(([name]) => name.startsWith('___') || name.startsWith('unique_temp___'))) {
			assert.deepEqual(added[name], column.array ? [] : column.type === 'bigint' ? '0' : 0);
		}
		await assert.rejects(repository.insert({ date: 1700000000, ...(entity.columns.group ? { group: 'fixture-user-a' } : {}) }), error => error.code === '23505');
		readWrite.push({ series, span, table: entity.tableName, historicalRows: historical.rows.length, updatedMetric: metric, insertedId: added.id, uniqueViolation: '23505' });
	}
	assert.deepEqual(await history(), historyBefore);
	assert.deepEqual(await catalog(), schemaBefore);
	const driftTable = definitions[0].entity.tableName;
	await source.query(`ALTER TABLE ${identifier(driftTable)} ADD COLUMN chart_probe_drift integer`);
	const drift = await source.driver.createSchemaBuilder().log();
	assert(drift.upQueries.some(query => query.query.includes('chart_probe_drift')));
	assert((await catalog()).columns.some(column => column.column_name === 'chart_probe_drift'), 'inspection must not execute proposed DDL');
	await source.query(`ALTER TABLE ${identifier(driftTable)} DROP COLUMN chart_probe_drift`);
	const restored = await source.driver.createSchemaBuilder().log();
	assert.deepEqual(restored.upQueries, []);
	assert.deepEqual(restored.downQueries, []);
	assert.deepEqual(await history(), historyBefore);
	assert.deepEqual(await catalog(), schemaBefore);
	const artifacts = {
		'existing-db-fixture.json': { upstreamCommit: manifest.upstreamCommit, schemaManifestSha256: hash(bytes), origin: 'All 349 unmodified pinned upstream migrations on empty PostgreSQL; synthetic historical rows inserted independently with SQL before reopening via captured EntitySchema.', postgresMajor: (await source.query('SHOW server_version'))[0].server_version.split('.')[0], history: historyBefore, catalog: schemaBefore, fixture },
		'database-observations.json': { upstreamCommit: manifest.upstreamCommit, schemaManifestSha256: hash(bytes), tables: definitions.length, migrations: historyBefore.length, schemaDiff: { up: 0, down: 0 }, readWrite, historyUnchanged: true, catalogUnchanged: true, injectedDriftDetectedWithoutApplyingDdl: true, restoredSchemaDiff: { up: 0, down: 0 } },
	};
	for (const [name, value] of Object.entries(artifacts)) {
		const output = JSON.stringify(value, null, 2) + '\n';
		const target = new URL(name, import.meta.url);
		if (process.argv[2] === '--write') writeFileSync(target, output);
		else assert.equal(readFileSync(target, 'utf8'), output);
	}
	console.log(`chart-storage database: ${definitions.length} tables / ${fixture.reduce((count, f) => count + f.rows.length, 0)} historical rows; read/update/insert/uniqueness/drift/history PASS ${process.argv[2]}`);
} finally {
	if (source?.isInitialized) await source.destroy();
	await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
	await admin.destroy();
}
