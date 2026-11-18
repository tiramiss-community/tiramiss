/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function config(extra: string) {
	const directory = await mkdtemp(join(tmpdir(), 'database-replica-config-'));
	directories.push(directory);
	const file = join(directory, 'config.yml');
	await writeFile(file, dump({
		url: 'https://example.test', port: 3000,
		db: { host: 'localhost', port: 5432 },
		redis: { host: 'localhost', port: 6379 },
		...(load(extra) as object),
	}));
	return file;
}

test('normalizes enabled upstream database replicas without inheriting primary credentials', async () => {
	const value = await loadConfig({ configFile: await config(`dbReplications: true
dbSlaves:
  - {host: replica, port: 5433, db: replica-db, user: reader, pass: ''}`), env: { DATABASE_DB: 'primary', DATABASE_USER: 'writer' } });
	expect(value.database).toMatchObject({ replicas: [{ host: 'replica', port: 5433, database: 'replica-db', username: 'reader', password: '' }] });
});

test.each(['{}', 'dbReplications: false\ndbSlaves: invalid'])('ignores inactive upstream replica settings: %s', async extra => {
	const value = await loadConfig({ configFile: await config(extra), env: { DATABASE_DB: 'primary', DATABASE_USER: 'writer' } });
	expect(value.database).not.toHaveProperty('replicas');
});

test('preserves an empty enabled slave list for TypeORM primary fallback', async () => {
	const value = await loadConfig({ configFile: await config('dbReplications: true\ndbSlaves: []'), env: { DATABASE_DB: 'primary', DATABASE_USER: 'writer' } });
	expect(value.database).toMatchObject({ replicas: [] });
});

test.each([['dbReplications: true', 'dbSlaves'], ['dbReplications: true\ndbSlaves: {}', 'dbSlaves'], ['dbReplications: true\ndbSlaves: [{host: replica, port: 0}]', 'dbSlaves[0].port'], ['dbReplications: yes', 'dbReplications']])(
	'rejects malformed enabled replica configuration: %s', async (extra, field) => {
		await expect(loadConfig({ configFile: await config(extra), env: { DATABASE_DB: 'primary', DATABASE_USER: 'writer' } })).rejects.toMatchObject({ code: 'INVALID_CONFIG', details: { field } });
	},
);
