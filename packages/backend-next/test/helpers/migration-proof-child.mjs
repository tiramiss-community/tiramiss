/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource } from 'typeorm';
import { migrations } from 'backend-upstream/migrations';
import { migrationSources } from '../../built/platform/database/migration-sources.js';
import { migrateDatabase } from '../../built/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../built/platform/database/check-migrations.js';

// The parent starts a fresh process with the environment set before these imports:
// upstream migration modules capture CONCURRENTLY once, at module evaluation.
const [scenario, rawConfig] = process.argv.slice(2);
const config = JSON.parse(rawConfig);
const database = `backend_next_${randomUUID().replaceAll('-', '')}`;
const admin = await new DataSource({ type: 'postgres', ...config }).initialize();
await admin.query(`CREATE DATABASE "${database}"`);
config.database = database;
const connection = await new DataSource({ type: 'postgres', ...config }).initialize();
const directory = await mkdtemp(join(tmpdir(), 'migration-proof-568-'));
const concurrent = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';
const composite = 'CompositeNoteIndex1745378064470';
const pin = 'NoteIdIndexForPinAndFavorite1780059833698';
const indexNames = ['IDX_724b311e6f883751f261ebe378', 'IDX_0e00498f180193423c992bc437', 'IDX_68881008f7c3588ad7ecae471c', 'IDX_a6f649630f55af3888e5a42919'];
const query = (sql, parameters) => connection.query(sql, parameters);
const history = () => query('SELECT id, timestamp, name FROM public.migrations ORDER BY id');
const indexes = () => query('SELECT c.relname AS name, c.oid, i.indisvalid AS valid, i.indisunique AS unique, pg_get_indexdef(c.oid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname = ANY($1) ORDER BY c.relname', [indexNames]);
const migrationSource = (selected) => {
	const source = migrationSources(config).upstream;
	if (selected) {
		source.setOptions({ migrations: selected });
	}
	return source;
};

async function apply(selected) {
	const source = migrationSource(selected);
	try {
		await source.initialize();
		await source.runMigrations();
	} finally {
		if (source.isInitialized) {
			await source.destroy();
		}
	}
}

async function diagnostic(operation) {
	try {
		await operation();
		return null;
	} catch (error) {
		return { code: error.code, details: error.details };
	}
}

async function cli(entry) {
	const path = join(directory, 'test.json');
	await writeFile(path, JSON.stringify({ url: 'https://example.test', port: 3000, db: { host: config.host, port: config.port, db: database, user: config.username, pass: config.password }, redis: { host: '127.0.0.1', port: 56568 } }));
	try {
		const result = await promisify(execFile)(process.execPath, [new URL(`../../built/entrypoints/${entry}.js`, import.meta.url).pathname], { env: { ...process.env, MISSKEY_CONFIG_YML: path }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
		return { exit: 0, events: result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)) };
	} catch (error) {
		return { exit: error.code, events: error.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)) };
	}
}

try {
	let result;
	if (scenario === 'history') {
		const missing = await cli('check-migrations');
		assert.equal(missing.exit, 1);
		assert.equal(missing.events.at(-1).error.code, 'MIGRATION_HISTORY_MISSING');
		assert.deepEqual(await query("SELECT to_regclass('public.migrations') AS history"), [{ history: null }]);
		await apply(migrations.slice(0, -1));
		const before = await history();
		assert.equal(before.length, 348);
		// This fixture rejects any internal history write before all 349 upstream rows.
		await query('CREATE SCHEMA backend_internal');
		await query('CREATE TABLE backend_internal.migrations (id SERIAL PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)');
		await query(`CREATE FUNCTION backend_internal.require_upstream() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM public.migrations) != 349 THEN RAISE EXCEPTION 'upstream incomplete'; END IF; RETURN NEW; END $$`);
		await query('CREATE TRIGGER upstream_first BEFORE INSERT ON backend_internal.migrations FOR EACH ROW EXECUTE FUNCTION backend_internal.require_upstream()');
		const applied = await cli('migrate');
		assert.equal(applied.exit, 0);
		assert.deepEqual((await history()).filter(row => row.name !== migrations.at(-1).name), before);
		const after = await history();
		const repeated = await cli('migrate');
		assert.equal(repeated.exit, 0);
		assert.deepEqual(await history(), after);
		const checks = [await cli('check-migrations'), await cli('check-schema')];
		assert.deepEqual(checks.map(check => check.exit), [0, 0]);
		const removed = before[0];
		await query('DELETE FROM public.migrations WHERE id=$1', [removed.id]);
		const pending = await cli('check-migrations');
		assert.equal(pending.exit, 1);
		assert.equal(pending.events.at(-1).error.code, 'PENDING_MIGRATIONS');
		assert.equal(pending.events.at(-1).error.details.count, 1);
		assert.equal((await history()).length, 348);
		await query('INSERT INTO public.migrations(id,timestamp,name) VALUES($1,$2,$3)', [removed.id, removed.timestamp, removed.name]);
		await query('ALTER TABLE public.role ADD COLUMN "migrationProofDrift" text');
		const historyWithDrift = await cli('check-migrations');
		const drift = await cli('check-schema');
		assert.equal(historyWithDrift.exit, 0);
		assert.equal(drift.exit, 1);
		assert.equal(drift.events.at(-1).error.code, 'SCHEMA_DRIFT');
		assert.deepEqual(await history(), after);
		assert.equal((await query(`SELECT column_name FROM information_schema.columns WHERE table_name='role' AND column_name='migrationProofDrift'`)).length, 1);
		await query('ALTER TABLE public.role DROP COLUMN "migrationProofDrift"');
		assert.equal((await cli('check-schema')).exit, 0);
		result = { before: before.length, after: after.length, preserved: true, repeated: true, checks: checks.map(check => check.exit), missing: missing.events.at(-1).error, pending: pending.events.at(-1).error, drift: drift.events.at(-1).error.code, internalCount: (await query('SELECT * FROM backend_internal.migrations')).length, indexes: await indexes() };
	} else if (scenario === 'failure') {
		const position = migrations.findIndex(migration => migration.name === pin);
		await apply(migrations.slice(0, position));
		const before = await history();
		await query('ALTER TABLE user_note_pining RENAME COLUMN "noteId" TO "blockedNoteId"');
		await assert.rejects(migrateDatabase(config), { code: '42703' });
		assert.deepEqual(await history(), before);
		assert.deepEqual(await query("SELECT to_regnamespace('backend_internal') AS internal"), [{ internal: null }]);
		const remaining = await indexes();
		const first = remaining.find(index => index.name === indexNames[1]);
		assert.equal(Boolean(first), concurrent);
		assert.equal(remaining.some(index => index.name === indexNames[2]), false);
		const pending = await diagnostic(() => assertMigrationsApplied(config));
		assert.equal(pending.code, 'PENDING_MIGRATIONS');
		assert.equal(pending.details.scope, 'upstream');
		assert.ok(pending.details.migrations.includes(pin));
		await query('ALTER TABLE user_note_pining RENAME COLUMN "blockedNoteId" TO "noteId"');
		await migrateDatabase(config);
		await assertMigrationsApplied(config);
		const recovered = await indexes();
		assert.equal(recovered.length, 3);
		assert.ok(recovered.every(index => index.valid));
		if (concurrent) {
			assert.equal(recovered.find(index => index.name === indexNames[1]).oid, first.oid);
		}
		assert.deepEqual((await history()).filter(row => before.some(old => old.name === row.name)), before);
		await query('DELETE FROM public.migrations WHERE name=$1', [pin]);
		await migrateDatabase(config);
		assert.deepEqual(await indexes(), recovered);
		result = { before: before.length, after: (await history()).length, firstIndexRemained: Boolean(first), secondIndexRemained: false, internalAbsentOnFailure: true, pending: pending.details.count, recoveredValid: true, validIndexesReused: true };
	} else if (scenario === 'composite') {
		const selected = migrations.filter(migration => migration.name === composite);
		await query('CREATE TABLE "user" (id varchar)');
		await query('CREATE TABLE note (id varchar, "userId" varchar)');
		await query(`INSERT INTO note VALUES ('note', 'user'), ('note', 'user')`);
		await query(`CREATE INDEX "IDX_5b87d9d19127bd5d92026017a7" ON note ("userId")`);
		// PostgreSQL itself leaves an invalid index after a failed concurrent unique build.
		await assert.rejects(query(`CREATE UNIQUE INDEX CONCURRENTLY "${indexNames[0]}" ON note ("userId", id DESC)`), { code: '23505' });
		const [invalid] = await indexes();
		assert.equal(invalid.valid, false);
		assert.equal(invalid.unique, true);
		await apply(selected);
		const [repaired] = await indexes();
		assert.equal(repaired.valid, true);
		assert.notEqual(repaired.oid, invalid.oid);
		assert.equal(repaired.unique, false);
		assert.equal(repaired.definition, `CREATE INDEX "${indexNames[0]}" ON public.note USING btree ("userId", id DESC)`);
		assert.deepEqual(await query(`SELECT to_regclass('"IDX_5b87d9d19127bd5d92026017a7"') AS old`), [{ old: null }]);
		await query('DELETE FROM public.migrations');
		await apply(selected);
		assert.deepEqual(await indexes(), [repaired]);
		result = { invalidBefore: true, validAfter: true, invalidReplaced: true, validReused: true, oldIndexDropped: true, definition: repaired.definition };
	} else if (scenario === 'invalid-pin') {
		await query('CREATE TABLE note_favorite ("noteId" varchar)');
		await query('CREATE TABLE user_note_pining ("noteId" varchar)');
		for (const [table, name] of [['note_favorite', indexNames[1]], ['user_note_pining', indexNames[2]]]) {
			await query(`INSERT INTO ${table} VALUES ('same-note'), ('same-note')`);
			await assert.rejects(query(`CREATE UNIQUE INDEX CONCURRENTLY "${name}" ON ${table} ("noteId")`), { code: '23505' });
		}
		const invalid = await indexes();
		assert.equal(invalid.length, 2);
		assert.ok(invalid.every(index => !index.valid && index.unique));
		await apply(migrations.filter(migration => migration.name === pin));
		const repaired = await indexes();
		assert.equal(repaired.length, 2);
		assert.ok(repaired.every(index => index.valid && !index.unique && index.oid !== invalid.find(old => old.name === index.name).oid));
		assert.deepEqual(repaired.map(index => index.definition), [
			`CREATE INDEX "${indexNames[1]}" ON public.note_favorite USING btree ("noteId")`,
			`CREATE INDEX "${indexNames[2]}" ON public.user_note_pining USING btree ("noteId")`,
		]);
		result = { invalidBefore: 2, validNonUniqueAfter: 2, invalidReplaced: true, definitions: repaired.map(index => index.definition) };
	} else if (scenario === 'transaction') {
		const source = migrationSource(migrations.filter(migration => [composite, pin].includes(migration.name)));
		await source.initialize();
		try {
			assert.equal(source.options.migrationsTransactionMode, concurrent ? 'each' : 'all');
			assert.deepEqual(source.migrations.map(migration => migration.transaction), concurrent ? [false, false] : [undefined, undefined]);
			if (concurrent) {
				await assert.rejects(source.runMigrations({ transaction: 'all' }), { name: 'ForbiddenTransactionModeOverrideError' });
				assert.equal((await history()).length, 0);
				assert.deepEqual(await indexes(), []);
			}
			result = { mode: source.options.migrationsTransactionMode, transaction: source.migrations.map(migration => migration.transaction ?? null), incompatibleAllRejected: concurrent };
		} finally {
			await source.destroy();
		}
	} else {
		throw new Error(`Unknown scenario: ${scenario}`);
	}
	process.stdout.write(`MIGRATION_PROOF_RESULT ${JSON.stringify(result)}\n`);
} finally {
	await connection.destroy();
	await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
	await admin.destroy();
	await rm(directory, { recursive: true, force: true });
}
