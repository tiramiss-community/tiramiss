/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiFollowing, MiNote, MiNoteFavorite, MiNoteThreadMuting, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createNotePersonalStateHttp } from '../../src/composition/note-personal-state-http.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { createNotePersonalStateStore } from '../../src/platform/database/note-personal-state.js';
import { createNoteNotificationReader } from '../../src/platform/database/note-notifications.js';
import { PostNotificationPersistence } from '../../src/platform/database/notification/persistence.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import corpus from '../../../../docs/superpowers/compatibility/note-personal-state/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/note-personal-state/observations.json' with { type: 'json' };
import type { MockInstance } from 'vitest';
import type { Server } from 'node:http';
import type { PersonalStateNote } from '../../src/modules/note-personal-state/public.js';

interface CorpusCase {
	id: string;
	note: Partial<PersonalStateNote> | null;
	steps: { operation: string; input?: object }[];
	favorites?: { id: string; userId: string; noteId: string }[];
	mutings?: { id: string; userId: string; threadId: string }[];
	achievements?: { name: string; unlockedAt: number }[];
	notificationMode?: string;
	following?: boolean;
	fail?: string;
}
const cases = corpus.cases as CorpusCase[];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
let stream: MockInstance<typeof resources.postingStream.main>;
const codec = createIdCodec('aidx');

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('personal-state-test', () => {}));
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: 'viewer', username: 'viewer', usernameLower: 'viewer', token: 'viewertoken12345' },
		{ id: 'other', username: 'other', usernameLower: 'other', token: 'othertoken123456' },
		{ id: 'author', username: 'author', usernameLower: 'author' },
		{ id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test' },
	]);
	await resources.dataSource.getRepository(MiUserProfile).insert(['viewer', 'other', 'author'].map(userId => ({ userId })));
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: 'favwrite', userId: 'viewer', token: 'favoriteaccesstoken', hash: 'favoriteaccesstoken', permission: ['write:favorites'] },
		{ id: 'accountwrite', userId: 'viewer', token: 'accountaccesstoken', hash: 'accountaccesstoken', permission: ['write:account'] },
		{ id: 'denied', userId: 'viewer', token: 'readaccesstoken123', hash: 'readaccesstoken123', permission: ['read:account'] },
	]);
	stream = vi.spyOn(resources.postingStream, 'main');
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

async function request(operation: string, input: object = { noteId: 'targetnote' }, token: string | null = 'viewertoken12345') {
	return fetch(`${url}/api/notes/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input }) });
}

async function reset(item: CorpusCase) {
	const source = resources.dataSource;
	await resources.favoriteAchievements.idle();
	await source.getRepository(MiNote).createQueryBuilder().delete().execute();
	await source.getRepository(MiNoteThreadMuting).createQueryBuilder().delete().execute();
	await source.getRepository(MiFollowing).createQueryBuilder().delete().execute();
	await source.query('TRUNCATE backend_internal.notification');
	await source.getRepository(MiUserProfile).upsert({ userId: 'author', achievements: (item.achievements ?? []) as MiUserProfile['achievements'], notificationRecieveConfig: item.notificationMode ? { achievementEarned: { type: item.notificationMode as 'never' } } : {} }, ['userId']);
	if (item.note !== null) {
		await source.getRepository(MiNote).insert({ id: 'targetnote', userId: 'author', text: 'target', visibility: 'public', ...item.note });
	}
	if (item.favorites?.length) {
		await source.getRepository(MiNoteFavorite).insert(item.favorites);
	}
	if (item.mutings?.length) {
		await source.getRepository(MiNoteThreadMuting).insert(item.mutings);
	}
	if (item.following) {
		await source.getRepository(MiFollowing).insert({ id: 'following', followerId: 'viewer', followeeId: 'author' });
	}
	stream.mockClear();
}

for (const item of cases) {
	const observed = observations.cases.find(observation => observation.id === item.id)!;
	test(`ordinary HTTP and PG match pinned endpoint/state/achievement behavior: ${item.id}`, async () => {
		await reset(item);
		const source = resources.dataSource;
		for (const [index, step] of item.steps.entries()) {
			const expected = observed.steps[index];
			const failedTable = item.fail === 'achievement' ? 'user_profile' : item.fail ? (step.operation.startsWith('favorites/') ? 'note_favorite' : 'note_thread_muting') : null;
			if (failedTable) {
				await source.query(`ALTER TABLE ${failedTable} RENAME TO ${failedTable}_unavailable`);
			}
			let response: Response;
			try {
				response = await request(step.operation, { noteId: 'targetnote', ...step.input });
				await resources.favoriteAchievements.idle();
			} finally {
				if (failedTable) {
					await source.query(`ALTER TABLE ${failedTable}_unavailable RENAME TO ${failedTable}`);
				}
			}
			if (expected.error) {
				if ('code' in expected.error) {
					expect(response.status).toBe(400);
					expect((await response.json()).error).toMatchObject(expected.error);
				} else {
					expect(response.status).toBe(500);
					expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
				}
			} else {
				expect(response.status).toBe(204);
				expect(await response.text()).toBe('');
			}
			for (const [entity, columns, expectedRows, table] of [
				[MiNoteFavorite, 'id,"userId","noteId"', expected.favorites, 'note_favorite'],
				[MiNoteThreadMuting, 'id,"userId","threadId"', expected.mutings, 'note_thread_muting'],
			] as const) {
				const rows = await source.query(`SELECT ${columns} FROM ${table} ORDER BY id`) as { id: string }[];
				const initial = entity === MiNoteFavorite ? item.favorites ?? [] : item.mutings ?? [];
				for (const row of rows) {
					if (!initial.some(previous => previous.id === row.id)) {
						row.id = corpus.newId;
					}
				}
				expect(rows).toEqual([...expectedRows].sort((a, b) => a.id.localeCompare(b.id)));
			}
			const store = createNotePersonalStateStore(source.manager, codec.createdAtFromId);
			const notifications = createNoteNotificationReader(source.manager);
			for (const read of expected.reads) {
				const threadId = item.note?.threadId ?? 'targetnote';
				expect(await store.hasFavorite(read.userId, 'targetnote')).toBe(read.isFavorited);
				expect(await store.hasThreadMute(read.userId, threadId)).toBe(read.isMutedThread);
				expect(await notifications.isThreadMuted(read.userId, threadId)).toBe(read.isMutedThread);
			}
			const profile = await source.getRepository(MiUserProfile).findOneByOrFail({ userId: 'author' });
			const achievements = profile.achievements.map(value => ({ ...value, unlockedAt: value.name === 'myNoteFavorited1' && !item.achievements?.length ? 1700000000000 : value.unlockedAt }));
			expect(achievements).toEqual(expected.achievements);
			const saved = await source.query('SELECT recipient_id AS "userId", notification_type AS type, achievement FROM backend_internal.notification ORDER BY notification_id');
			expect(saved).toEqual(expected.notifications);
			const published = stream.mock.calls.filter(([, type, body]) => type === 'notification' && (body as { type?: string }).type === 'achievementEarned').map(([userId, , body]) => ({ userId, type: (body as { type: string }).type, achievement: (body as { achievement: string }).achievement }));
			expect(published).toEqual(expected.notifications);
		}
	});
}

test('credential/scope/suspension/moved/input gates preserve endpoint-specific access', async () => {
	await reset({ id: 'gate', note: {}, steps: [] });
	for (const operation of ['favorites/create', 'favorites/delete', 'thread-muting/create', 'thread-muting/delete']) {
		for (const [token, code] of [[null, 'CREDENTIAL_REQUIRED'], ['invalidtoken12345', 'AUTHENTICATION_FAILED'], ['readaccesstoken123', 'PERMISSION_DENIED']] as const) {
			expect((await (await request(operation, {}, token)).json()).error.code).toBe(code);
		}
		expect((await (await request(operation, { noteId: 'invalid-id' })).json()).error.code).toBe('INVALID_PARAM');
	}
	await resources.dataSource.getRepository(MiUser).update('viewer', { isSuspended: true });
	try {
		expect((await (await request('favorites/create', {}, 'readaccesstoken123')).json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update('viewer', { isSuspended: false, movedToUri: 'https://remote.test/@moved' });
	}
	try {
		expect((await (await request('favorites/create', {})).json()).error.code).toBe('YOUR_ACCOUNT_MOVED');
		expect((await request('thread-muting/create', { noteId: 'targetnote' }, 'accountaccesstoken')).status).toBe(204);
		expect((await request('favorites/create', { noteId: 'targetnote' }, 'accountaccesstoken')).status).toBe(403);
	} finally {
		await resources.dataSource.getRepository(MiUser).update('viewer', { movedToUri: null });
	}
	expect((await request('favorites/create', { noteId: 'targetnote' }, 'favoriteaccesstoken')).status).toBe(204);
	expect((await request('thread-muting/delete', { noteId: 'targetnote' }, 'favoriteaccesstoken')).status).toBe(403);
});

test('favorite uniqueness/cascade and thread mute lifetime match upstream entities', async () => {
	await reset({ id: 'constraints', note: {}, steps: [] });
	const source = resources.dataSource;
	const favorites = source.getRepository(MiNoteFavorite);
	const mutings = source.getRepository(MiNoteThreadMuting);
	await favorites.insert({ id: 'favorite', userId: 'viewer', noteId: 'targetnote' });
	await mutings.insert({ id: 'mute', userId: 'viewer', threadId: 'targetnote' });
	await expect(favorites.insert({ id: 'duplicate', userId: 'viewer', noteId: 'targetnote' })).rejects.toThrow();
	await expect(mutings.insert({ id: 'duplicate', userId: 'viewer', threadId: 'targetnote' })).rejects.toThrow();
	await expect(favorites.insert({ id: 'missing', userId: 'viewer', noteId: 'missing' })).rejects.toThrow();
	await expect(mutings.insert({ id: 'missing', userId: 'missing', threadId: 'targetnote' })).rejects.toThrow();
	await source.getRepository(MiNote).delete('targetnote');
	expect(await favorites.count()).toBe(0);
	expect(await mutings.count()).toBe(1);
	await source.getRepository(MiUser).insert({ id: 'disposable', username: 'disposable', usernameLower: 'disposable' });
	await source.getRepository(MiNote).insert({ id: 'cascade', userId: 'author', visibility: 'public' });
	await favorites.insert({ id: 'disposablefav', userId: 'disposable', noteId: 'cascade' });
	await mutings.insert({ id: 'disposablemute', userId: 'disposable', threadId: 'cascade' });
	await source.getRepository(MiUser).delete('disposable');
	expect(await favorites.count()).toBe(0);
	expect(await mutings.countBy({ userId: 'disposable' })).toBe(0);
});

test('achievement schema/migration preserves note invariants, retention, flush and rollback', async () => {
	await resources.favoriteAchievements.idle();
	const source = resources.dataSource;
	await source.query('TRUNCATE backend_internal.notification');
	const persistence = new PostNotificationPersistence({ perUserNotificationsMaxCount: 2 });
	const base = { recipientId: 'author', createdAtMs: 1, type: 'achievementEarned' as const, achievement: 'myNoteFavorited1' };
	await source.transaction(manager => persistence.save(manager, { ...base, id: 'achievement' }));
	await source.transaction(manager => persistence.save(manager, { id: 'mention', recipientId: 'author', type: 'mention', notifierId: 'viewer', noteId: 'n', targetNoteId: null, createdAtMs: 2 }));
	await expect(source.query("UPDATE backend_internal.notification SET note_id='n' WHERE notification_id='achievement'")).rejects.toThrow();
	await expect(source.query("UPDATE backend_internal.notification SET achievement='bad' WHERE notification_id='mention'")).rejects.toThrow();
	await expect(source.query("UPDATE backend_internal.notification SET notifier_id=NULL WHERE notification_id='mention'")).rejects.toThrow();
	await source.transaction(manager => persistence.save(manager, { ...base, id: 'newachievement', createdAtMs: 3 }));
	expect(await source.query('SELECT notification_id FROM backend_internal.notification ORDER BY created_at')).toEqual([{ notification_id: 'mention' }, { notification_id: 'newachievement' }]);
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	const internal = await migrationSources(database.config.database).internal.initialize();
	try {
		await internal.undoLastMigration();
		expect(await source.query('SELECT notification_id FROM backend_internal.notification')).toEqual([{ notification_id: 'mention' }]);
		await internal.runMigrations();
	} finally {
		await internal.destroy();
	}
	await assertSchemaMatches(database.config.database);
	await source.transaction(manager => persistence.flush(manager, 'author'));
	expect(await source.query('SELECT notification_id FROM backend_internal.notification')).toEqual([]);
});

test('normal concurrent favorites grant once and preserve a different existing achievement', async () => {
	await reset({ id: 'concurrent', note: {}, steps: [], achievements: [{ name: 'notes1', unlockedAt: 123 }] });
	await resources.dataSource.getRepository(MiNote).insert({ id: 'anothernote', userId: 'author', text: 'second', visibility: 'public' });
	const responses = await Promise.all([request('favorites/create'), request('favorites/create', { noteId: 'anothernote' })]);
	expect(responses.map(response => response.status)).toEqual([204, 204]);
	await resources.favoriteAchievements.idle();
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: 'author' });
	expect(profile.achievements).toEqual([{ name: 'notes1', unlockedAt: 123 }, { name: 'myNoteFavorited1', unlockedAt: expect.any(Number) }]);
	expect(await resources.dataSource.query("SELECT achievement FROM backend_internal.notification WHERE notification_type='achievementEarned'")).toEqual([{ achievement: 'myNoteFavorited1' }]);
	expect(await resources.dataSource.getRepository(MiNoteFavorite).countBy({ userId: 'viewer' })).toBe(2);
});

test('HTTP mute suppresses ordinary posting mention/reply notifications and unmute restores them', async () => {
	await reset({ id: 'consumer', note: { userId: 'viewer' }, steps: [] });
	await resources.dataSource.getRepository(MiNote).insert({ id: 'replynote', userId: 'author', text: 'reply', visibility: 'public', threadId: 'targetnote', replyId: 'targetnote', replyUserId: 'viewer', mentions: ['viewer'] });
	expect((await request('thread-muting/create')).status).toBe(204);
	const events = resources.postingNotifications.createdEvents(async () => {});
	await events('replynote');
	expect(await resources.dataSource.query("SELECT notification_type FROM backend_internal.notification WHERE recipient_id='viewer'")).toEqual([]);
	expect(stream.mock.calls.filter(([userId, type]) => userId === 'viewer' && ['mention', 'reply', 'notification'].includes(type))).toEqual([]);
	expect((await request('thread-muting/delete', { noteId: 'replynote' })).status).toBe(204);
	await events('replynote');
	expect(await resources.dataSource.query("SELECT notification_type FROM backend_internal.notification WHERE recipient_id='viewer'")).toEqual([{ notification_type: 'reply' }]);
	expect(stream.mock.calls.filter(([userId, type]) => userId === 'viewer' && type === 'mention')).toHaveLength(1);
	expect(stream.mock.calls.filter(([userId, type]) => userId === 'viewer' && type === 'reply')).toHaveLength(1);
});

test('notification persistence/publish failure keeps favorite and achievement grant, without retrying the grant', async () => {
	await reset({ id: 'notification-failure', note: {}, steps: [] });
	await resources.dataSource.query('ALTER TABLE backend_internal.notification RENAME TO notification_unavailable');
	try {
		expect((await request('favorites/create')).status).toBe(204);
		await resources.favoriteAchievements.idle();
	} finally {
		await resources.dataSource.query('ALTER TABLE backend_internal.notification_unavailable RENAME TO notification');
	}
	expect(await resources.dataSource.getRepository(MiNoteFavorite).count()).toBe(1);
	expect((await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: 'author' })).achievements).toMatchObject([{ name: 'myNoteFavorited1' }]);
	expect((await request('favorites/delete')).status).toBe(204);
	expect((await request('favorites/create')).status).toBe(204);
	await resources.favoriteAchievements.idle();
	expect(await resources.dataSource.query('SELECT notification_id FROM backend_internal.notification')).toEqual([]);
	await reset({ id: 'publish-failure', note: {}, steps: [] });
	stream.mockRejectedValueOnce(Error('publish unavailable'));
	expect((await request('favorites/create')).status).toBe(204);
	await resources.favoriteAchievements.idle();
	expect(await resources.dataSource.query('SELECT achievement FROM backend_internal.notification')).toEqual([{ achievement: 'myNoteFavorited1' }]);
});

test('production Redis limits use separate create windows and leave both deletes unlimited', async () => {
	await reset({ id: 'rate', note: {}, steps: [] });
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = 'production';
	let app: ReturnType<typeof createNotePersonalStateHttp>;
	try {
		app = createNotePersonalStateHttp(resources, database.config);
	} finally {
		process.env.NODE_ENV = previous;
	}
	const limitedServer = await listenHttp(app, { port: 0 });
	const origin = `http://127.0.0.1:${(limitedServer.address() as { port: number }).port}`;
	try {
		for (const [operation, maximum] of [['favorites/create', 20], ['thread-muting/create', 10]] as const) {
			for (let index = 0; index < maximum; index++) {
				const response = await fetch(`${origin}/api/notes/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: 'viewertoken12345', noteId: 'missing' }) });
				expect((await response.json()).error.code).toBe('NO_SUCH_NOTE');
			}
			const response = await fetch(`${origin}/api/notes/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: 'viewertoken12345', noteId: 'targetnote' }) });
			expect(response.status).toBe(429);
			expect((await response.json()).error.code).toBe('RATE_LIMIT_EXCEEDED');
			expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
		}
		for (const operation of ['favorites/delete', 'thread-muting/delete']) {
			const response = await fetch(`${origin}/api/notes/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: 'viewertoken12345', noteId: 'targetnote' }) });
			expect(response.status).toBe(operation === 'favorites/delete' ? 400 : 204);
		}
	} finally {
		await closeHttp(limitedServer);
	}
});
