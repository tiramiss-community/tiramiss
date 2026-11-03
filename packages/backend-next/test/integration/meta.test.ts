/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiMeta } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { readFederationPolicy, readMeta } from '../../src/platform/database/meta.js';
import { createTestDatabase } from '../helpers/database.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = createDataSource(database.config.database);
	await source.initialize();
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

beforeEach(async () => {
	await source.getRepository(MiMeta).deleteAll();
});

test('the row with the largest id is used when several rows exist', async () => {
	await source.getRepository(MiMeta).insert([{ id: 'a', name: 'old' }, { id: 'singleton', name: 'new' }, { id: 'b', name: 'middle' }]);

	expect((await readMeta(source.manager)).name).toBe('new');
});

test('a missing row is created with id x and column defaults', async () => {
	const meta = await readMeta(source.manager);

	expect(meta.id).toBe('x');
	expect(meta.federation).toBe('none');
	expect(meta.blockedHosts).toEqual([]);
	expect(await source.getRepository(MiMeta).count()).toBe(1);
});

test('concurrent first reads leave exactly one row', async () => {
	const metas = await Promise.all(Array.from({ length: 8 }, () => readMeta(source.manager)));

	expect(new Set(metas.map(m => m.id))).toEqual(new Set(['x']));
	expect(await source.getRepository(MiMeta).find({ select: { id: true } })).toEqual([{ id: 'x' }]);
});

test('an existing x row is read without being overwritten', async () => {
	await source.getRepository(MiMeta).insert({ id: 'x', name: 'kept' });

	expect((await readMeta(source.manager)).name).toBe('kept');
});

test('federation policy is read from the selected row', async () => {
	await source.getRepository(MiMeta).insert({
		id: 'singleton',
		federation: 'specified',
		federationHosts: ['allowed.example'],
		blockedHosts: ['blocked.example'],
		silencedHosts: ['silenced.example'],
		mediaSilencedHosts: ['media.example'],
		deliverSuspendedSoftware: [{ software: 'misskey', versionRange: '< 2024.1.0' }],
	});

	expect(await readFederationPolicy(source.manager)).toEqual({
		federation: 'specified',
		federationHosts: ['allowed.example'],
		blockedHosts: ['blocked.example'],
		silencedHosts: ['silenced.example'],
		mediaSilencedHosts: ['media.example'],
		deliverSuspendedSoftware: [{ software: 'misskey', versionRange: '< 2024.1.0' }],
	});
});
