/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { configuration } from '../helpers/process.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
});
afterAll(async () => {
	await database?.close();
});

async function failure(command: string) {
	const config = await configuration({ ...database.config, http: { port: 3000 } });
	try {
		const result = await promisify(execFile)(process.execPath, [`built/entrypoints/${command}.js`], {
			env: { ...process.env, MISSKEY_CONFIG_YML: config.path },
		}).then(
			() => {
				throw new Error('Expected CLI failure');
			},
			(error) => error as { code: number; stdout: string },
		);
		expect(result.code).toBe(1);
		return JSON.parse(result.stdout.trim());
	} finally {
		await config.close();
	}
}

test('reports schema difference SQL and scope through the public CLI without credentials', async () => {
	const source = await createDataSource(database.config.database).initialize();
	try {
		await source.query('ALTER TABLE public.role ADD COLUMN "diagnosticDrift" text');
	} finally {
		await source.destroy();
	}
	const log = await failure('check-schema');
	expect(log.error).toMatchObject({ code: 'SCHEMA_DRIFT', details: { scope: 'upstream' } });
	expect(log.error.details.up.join(' ')).toContain('diagnosticDrift');
	expect(JSON.stringify(log)).not.toContain('foundation-test-only');
});
test('reports which migration history is missing through the public CLI', async () => {
	const source = await createDataSource(database.config.database).initialize();
	try {
		await source.query('DROP TABLE backend_internal.migrations');
	} finally {
		await source.destroy();
	}
	const log = await failure('check-migrations');
	expect(log.error).toMatchObject({ code: 'MIGRATION_HISTORY_MISSING', details: { scope: 'internal' } });
});
