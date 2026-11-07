/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiInstance, MiMeta, MiNote, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import type { NewNote, NoteCreatedSnapshot } from '../../src/modules/note/public.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const admin = { id: id(), token: 'instance00000001' };
const remote = id();
const logs: string[] = [];

async function remoteNote(host = 'remote.example'): Promise<NoteCreatedSnapshot> {
	const noteId = id();
	await resources.dataSource.getRepository(MiNote).insert({
		id: noteId, userId: remote, userHost: host, text: 'remote', visibility: 'public', localOnly: true
	});
	const raw = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: noteId });
	const note: NewNote = { ...raw, mentionedRemoteUsers: JSON.parse(raw.mentionedRemoteUsers) };
	return {
		note, author: {
			id: remote, username: 'remote', host, isBot: false
		}, channel: null, reply: null, renote: null, rawNote: { ...raw, reply: null, renote: null }
	};
}

const count = async (host: string) => (await resources.dataSource.getRepository(MiInstance).findOneBy({ host }))?.notesCount;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	// Choose the actual production five-minute deadline while keeping the test itself immediate through close().
	const old = process.env.NODE_ENV;
	process.env.NODE_ENV = 'production';
	try {
		resources = await connectResources(database.config, createLogger('instance-counts-test', line => logs.push(line)));
	} finally {
		process.env.NODE_ENV = old;
	}
	await resources.dataSource.getRepository(MiUser).insert([{ ...admin, username: 'admin', usernameLower: 'admin' }, {
			id: remote, username: 'remote', usernameLower: 'remote', host: 'remote.example'
		}]);
	await resources.dataSource.getRepository(MiUserProfile).insert([{ userId: admin.id }, { userId: remote }]);
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: admin.id, enableStatsForFederatedInstances: true });
	app = createBackendHttpApp(resources, database.config);
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
});
test('captured remote post-save registers via real Redis/PG and shutdown flush sums by instance ID without refreshing cached row', async () => {
	const first = await remoteNote();
	const second = await remoteNote();
	for (const snapshot of [first, second]) {
		resources.notePostSave.start({
			noteId: snapshot.note.id, userId: remote, repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null, createdSnapshot: snapshot
		});
	}
	await resources.notePostSave.idle();
	expect(await count('remote.example')).toBe(0);
	const cached = await resources.redis.get('kvcache:federatedInstance:remote.example');
	expect(JSON.parse(cached!)).toMatchObject({ notesCount: 0 });
	await resources.noteInstanceCounts.close();
	expect(await count('remote.example')).toBe(2);
	expect(await resources.redis.get('kvcache:federatedInstance:remote.example')).toBe(cached);
});
test('real admin HTTP remote delete decrements directly and a failed DELETE retains the already-started count', async () => {
	for (const fail of [false, true]) {
		const snapshot = await remoteNote();
		const before = await count('remote.example');
		if (fail) {
			await resources.dataSource.query('CREATE FUNCTION reject_remote_note_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'delete failed\'; END $$');
			await resources.dataSource.query('CREATE TRIGGER reject_remote_delete BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION reject_remote_note_delete()');
		}
		try {
			const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: admin.token, noteId: snapshot.note.id }) });
			expect(response.status).toBe(fail ? 500 : 204);
			await resources.notePostDelete.idle();
			expect(await count('remote.example')).toBe(before! - 1);
			expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: snapshot.note.id })).toBe(fail);
		} finally {
			if (fail) {
				await resources.dataSource.query('DROP TRIGGER reject_remote_delete ON note');
				await resources.dataSource.query('DROP FUNCTION reject_remote_note_delete()');
			}
		}
	}
});
test('remote count uses captured host, remains independent of packed-render failure, and disabled stats do not register', async () => {
	const snapshot = await remoteNote('captured.example');
	const pack = vi.spyOn(resources.dataSource.getRepository(MiUser), 'find').mockRejectedValue(new Error('pack material unavailable'));
	try {
		resources.notePostSave.start({
			noteId: snapshot.note.id, userId: remote, repliedNoteId: null, renotedNoteId: null, channelId: null, pollExpiresAtMs: null, createdSnapshot: snapshot
		});
		await resources.notePostSave.idle();
		await resources.noteInstanceCounts.close();
		expect(await count('captured.example')).toBe(1);
	} finally {
		pack.mockRestore();
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: false });
	await resources.noteInstanceCounts.created('disabled.example');
	await resources.noteInstanceCounts.deleted('disabled.example');
	await resources.noteInstanceCounts.close();
	expect(await count('disabled.example')).toBeUndefined();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
});
test('increment SQL failure is diagnosed once, loses the batch and is not retried on another close', async () => {
	await resources.noteInstanceCounts.created('failed.example');
	await resources.dataSource.query('CREATE FUNCTION reject_instance_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'instance count failed\'; END $$');
	await resources.dataSource.query('CREATE TRIGGER reject_instance_count BEFORE UPDATE OF "notesCount" ON instance FOR EACH ROW EXECUTE FUNCTION reject_instance_count()');
	try {
		await resources.noteInstanceCounts.close();
		expect(await count('failed.example')).toBe(0);
	} finally {
		await resources.dataSource.query('DROP TRIGGER reject_instance_count ON instance');
		await resources.dataSource.query('DROP FUNCTION reject_instance_count()');
	}
	await resources.noteInstanceCounts.close();
	expect(await count('failed.example')).toBe(0);
	expect(logs.filter(line => JSON.parse(line).event === 'note-instance-counts.failed')).toHaveLength(1);
});
