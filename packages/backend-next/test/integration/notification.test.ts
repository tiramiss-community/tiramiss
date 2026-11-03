/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { PostNotificationPersistence } from '../../src/platform/database/notification/persistence.js';
import type { PostNotification } from '../../src/modules/notification/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
const storage = new PostNotificationPersistence({ perUserNotificationsMaxCount: 2 });
const at = Date.UTC(2026, 10, 3);
const record = (id: string, type: PostNotification['type'] = 'mention', recipientId = 'recipient'): PostNotification => ({
	id, recipientId, type, notifierId: 'author', noteId: 'note', targetNoteId: type === 'renote' ? 'original' : null, createdAtMs: at,
});
const save = (notification: PostNotification) => source.transaction(manager => storage.save(manager, notification));
const bodies = () => source.query('SELECT * FROM backend_internal.notification ORDER BY notification_id');

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
});
beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.notification');
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test.each(['reply', 'mention', 'quote', 'renote', 'note'] as const)('saves a %s body directly without work claims or effects', async type => {
	await save(record('id', type));
	expect(await bodies()).toEqual([{
		notification_id: 'id', recipient_id: 'recipient', notification_type: type,
		notifier_id: 'author', note_id: 'note', target_note_id: type === 'renote' ? 'original' : null, created_at: new Date(at),
	}]);
});

test('rollback removes the new body and restores bodies trimmed in the same transaction', async () => {
	await save(record('1'));
	await save(record('2'));
	await expect(source.transaction(async manager => {
		await storage.save(manager, record('3'));
		throw new Error('abort');
	})).rejects.toThrow('abort');
	expect((await bodies()).map((row: { notification_id: string }) => row.notification_id)).toEqual(['1', '2']);
});

test('concurrent additions retain the newest two bodies by timestamp then ID, only for their recipient', async () => {
	await save(record('other', 'note', 'another'));
	await Promise.all(['1', '2', '3', '4', '5'].map(id => save(record(id))));
	expect((await bodies()).map((row: { notification_id: string }) => row.notification_id)).toEqual(['4', '5', 'other']);
});

test('retention orders by timestamp before ID and flush removes only the requested recipient', async () => {
	await save({ ...record('z'), createdAtMs: at - 1 });
	await save(record('a'));
	await save(record('b'));
	await save(record('other', 'note', 'another'));
	expect((await bodies()).map((row: { notification_id: string }) => row.notification_id)).toEqual(['a', 'b', 'other']);
	await source.transaction(manager => storage.flush(manager, 'recipient'));
	await source.transaction(manager => storage.flush(manager, 'recipient'));
	expect(await bodies()).toMatchObject([{ notification_id: 'other' }]);
});

test('flush and save serialize for the same recipient without deleting another recipient', async () => {
	await save(record('other', 'note', 'another'));
	const runner = source.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	try {
		await storage.flush(runner.manager, 'recipient');
		const pending = save(record('after'));
		await runner.commitTransaction();
		await pending;
		expect(await bodies()).toMatchObject([{ notification_id: 'after' }, { notification_id: 'other' }]);
	} finally {
		if (runner.isTransactionActive) {
			await runner.rollbackTransaction();
		}
		await runner.release();
	}
});

test('insert failures leave existing notifications intact', async () => {
	await save(record('one'));
	await expect(save(record('one'))).rejects.toThrow();
	await expect(save({ ...record('bad'), type: 'renote', targetNoteId: null })).rejects.toThrow();
	expect(await bodies()).toMatchObject([{ notification_id: 'one' }]);
});

test('requires a live caller-owned transaction for saving and flushing', async () => {
	await expect(storage.save(source.manager, record('one'))).rejects.toThrow('transaction');
	await expect(storage.flush(source.manager, 'recipient')).rejects.toThrow('transaction');
});

test.each([0, -1, 0.5, NaN, Infinity])('rejects invalid per-recipient retention %s', count => {
	expect(() => new PostNotificationPersistence({ perUserNotificationsMaxCount: count })).toThrow('count');
});
