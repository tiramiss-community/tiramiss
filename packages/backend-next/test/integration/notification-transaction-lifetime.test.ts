/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { MiMeta, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import * as notificationTransactions from '../../src/platform/database/poll-ended.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import type { PostNotificationWrites } from '../../src/modules/notification/public.js';

test('HTTP posting expires save before publication and later notifications keep working', async () => {
	const database = await createTestDatabase();
	let resources: Awaited<ReturnType<typeof connectResources>> | undefined;
	const createTransactions = notificationTransactions.createNotificationTransactions;
	const scopes: PostNotificationWrites[] = [];
	vi.spyOn(notificationTransactions, 'createNotificationTransactions').mockImplementation(db => {
		const transactions = createTransactions(db);
		return { run: work => transactions.run(writes => {
			scopes.push(writes);
			return work(writes);
		}) };
	});
	try {
		await migrateDatabase(database.config.database);
		resources = await connectResources(database.config, createLogger('notification-lifetime-test', () => {}));
		const source = resources.dataSource;
		const codec = createIdCodec('aidx');
		const alice = codec.newId(Date.now());
		const bob = codec.newId(Date.now());
		await source.getRepository(MiUser).insert([
			{ id: alice, username: 'alice', usernameLower: 'alice', token: 'lifetimealice000' },
			{ id: bob, username: 'bob', usernameLower: 'bob' },
		]);
		await source.getRepository(MiUserProfile).insert([{ userId: alice }, { userId: bob }]);
		await source.getRepository(MiMeta).insert({ id: 'singleton' });
		const app = createBackendHttpApp(resources, database.config);
		const publish = resources.postingStream.main;
		const published: unknown[] = [];
		vi.spyOn(resources.postingStream, 'main').mockImplementation(async (recipientId, type, body) => {
			if (type === 'notification') {
				await expect(scopes.at(-1)!.save({ id: 'escaped-posting', recipientId, type: 'mention', notifierId: alice,
					noteId: 'escaped-note', targetNoteId: null, createdAtMs: Date.now() })).rejects.toThrow('The transaction has ended');
				published.push(body);
			}
			await publish(recipientId, type, body);
		});
		const response = await app.request('/api/notes/create', {
			method: 'POST', body: JSON.stringify({ i: 'lifetimealice000', localOnly: true, text: '@bob lifetime' }),
		});
		expect(response.status).toBe(200);
		const noteId = (await response.json()).createdNote.id;
		await resources.notePostSave.idle();
		expect(scopes).toHaveLength(1);
		expect(published).toEqual([expect.objectContaining({ type: 'mention', note: expect.objectContaining({ id: noteId }) })]);
		expect(await source.query('SELECT notification_type, recipient_id, note_id FROM backend_internal.notification'))
			.toEqual([{ notification_type: 'mention', recipient_id: bob, note_id: noteId }]);
		const first = scopes[0];
		await notificationTransactions.createNotificationTransactions(source).run(async writes => {
			await expect(first.save({ id: 'escaped-later', recipientId: bob, type: 'mention', notifierId: alice,
				noteId, targetNoteId: null, createdAtMs: Date.now() })).rejects.toThrow('The transaction has ended');
			await writes.save({ id: 'accepted-later', recipientId: bob, type: 'mention', notifierId: alice,
				noteId, targetNoteId: null, createdAtMs: Date.now() });
		});
		expect(await source.query("SELECT notification_id FROM backend_internal.notification WHERE notification_id = 'accepted-later'"))
			.toEqual([{ notification_id: 'accepted-later' }]);
		expect(await source.query("SELECT notification_id FROM backend_internal.notification WHERE notification_id LIKE 'escaped-%'"))
			.toEqual([]);
	} finally {
		vi.restoreAllMocks();
		await resources?.close();
		await database.close();
	}
});
