/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiModerationLog, MiUser } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { appendModerationLog } from '../../src/platform/database/moderation-log.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
const codec = createIdCodec('aidx');
const occurredAtMs = Date.parse('2026-11-08T00:00:00.000Z');

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = createDataSource(database.config.database);
	await source.initialize();
	await source.getRepository(MiUser).insert({ id: 'moderator', username: 'moderator', usernameLower: 'moderator', host: null });
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

beforeEach(async () => {
	await source.getRepository(MiModerationLog).deleteAll();
});

const logs = () => source.getRepository(MiModerationLog).find();

test('an omitted info is stored as an empty object, like upstream ModerationLogService.log', async () => {
	await appendModerationLog(source.manager, { actorId: 'moderator', type: 'clearQueue', occurredAtMs }, codec.newId);

	const [log] = await logs();
	expect(log).toMatchObject({ userId: 'moderator', type: 'clearQueue' });
	expect(log.info).toStrictEqual({});
	expect(codec.createdAtFromId(log.id)).toBe(occurredAtMs);
});

test('info is stored as JSON the way TypeORM serializes jsonb (Date to ISO, undefined keys dropped)', async () => {
	const info = {
		noteId: 'n1', noteUserHost: null, nested: { list: [1, 'two', null], flag: true },
		at: new Date(occurredAtMs), missing: undefined, text: 'quote " and \\ and 日本語',
	};
	await appendModerationLog(source.manager, { actorId: 'moderator', type: 'deleteNote', info, occurredAtMs }, codec.newId);

	const [log] = await logs();
	expect(log.info).toStrictEqual({
		noteId: 'n1', noteUserHost: null, nested: { list: [1, 'two', null], flag: true },
		at: '2026-11-08T00:00:00.000Z', text: 'quote " and \\ and 日本語',
	});
});

test('the caller decides the transaction: a rolled back caller transaction leaves no record', async () => {
	await expect(source.transaction(async manager => {
		await appendModerationLog(manager, { actorId: 'moderator', type: 'updateRole', info: { roleId: 'r1' }, occurredAtMs }, codec.newId);
		throw new Error('rollback');
	})).rejects.toThrow('rollback');

	expect(await logs()).toEqual([]);
});

test('an insert failure is reported to the caller', async () => {
	await expect(appendModerationLog(source.manager, { actorId: 'missing-user', type: 'pauseQueue', occurredAtMs }, codec.newId)).rejects.toThrow();

	expect(await logs()).toEqual([]);
});
