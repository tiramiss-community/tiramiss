/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { createPollEndedQueue, startPollEndedWorker } from '../../src/platform/job-queue/ended-poll-notification.js';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiFollowing, MiMeta, MiMuting, MiNote, MiNoteThreadMuting, MiPoll, MiPollVote, MiRenoteMuting, MiUser, MiUserList, MiUserListMembership, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import type { NotePostSaveInput } from '../../src/modules/note/public.js';
import { createNoteNotificationReader } from '../../src/platform/database/note-notifications.js';
import { createPollEndedHandler } from '../../src/composition/poll-ended-job.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let subscriber: Redis;
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const users: Record<string, { id: string; token: string }> = {};
const messages: { channel: string; message: any }[] = [];
const logs: string[] = [];
const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
const bodies = (noteId: string) => resources.dataSource.query('SELECT * FROM backend_internal.notification WHERE note_id=$1 ORDER BY notification_type', [noteId]);

async function create(input: object, who = 'alice') {
	const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users[who].token, localOnly: true, ...input }) });
	expect(response.status).toBe(200);
	const result = await response.json();
	await resources.notePostSave.idle();
	await vi.waitFor(() => expect(messages.some(m => m.channel === 'notesStream' && m.message.id === result.createdNote.id)).toBe(true));
	return result.createdNote;
}

const main = (user: string, type: string) => messages.filter(m => m.channel === `mainStream:${users[user].id}` && m.message.type === type).map(m => m.message.body);

async function following(follower: string, followee: string, notify: null | 'normal' = null) {
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: users[follower].id, followeeId: users[followee].id, notify });
}

async function receive(user: string, type: string, mode: string, extra = {}) {
	await resources.dataSource.getRepository(MiUserProfile).update(users[user].id, { notificationRecieveConfig: { [type]: { type: mode, ...extra } } as never });
}

beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('notifications-test', line => logs.push(line)));
	for (const name of ['alice', 'bob', 'carol']) {
		users[name] = { id: id(), token: `noti${name.padEnd(12, '0')}` };
		await resources.dataSource.getRepository(MiUser).insert({ ...users[name], username: name, usernameLower: name });
		await resources.dataSource.getRepository(MiUserProfile).insert({ userId: users[name].id });
	}
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	app = createBackendHttpApp(resources, database.config);
	subscriber = new Redis({ ...database.config.redisForPubsub, keyPrefix: undefined });
	subscriber.on('message', (_channel, value) => messages.push(JSON.parse(value)));
	await subscriber.subscribe(new URL(database.config.url).host);
});
beforeEach(async () => {
	await resources.notePostSave.idle(); await resources.notePostDelete.idle();
	await resources.dataSource.query('TRUNCATE following, muting, renote_muting, note_thread_muting, user_list_membership CASCADE');
	await resources.dataSource.query('TRUNCATE backend_internal.notification');
	await resources.dataSource.getRepository(MiUserProfile).createQueryBuilder().update().set({ notificationRecieveConfig: {}, mutedInstances: [] }).execute();
	messages.length = 0; logs.length = 0;
});
afterAll(async () => {
	subscriber?.disconnect(); await resources?.close(); await database?.close();
});

test('exact producer notes/main/notification payloads and preincrement related count snapshot', async () => {
	const parent = await create({ text: 'parent' }, 'bob');
	messages.length = 0;
	const note = await create({ text: '@bob reply', replyId: parent.id });
	const stored = await bodies(note.id);
	expect(stored.map((n: any) => n.notification_type)).toEqual(['reply']);
	expect(stored[0]).toMatchObject({ recipient_id: users.bob.id, notifier_id: users.alice.id, target_note_id: null });
	const notes = messages.find(m => m.channel === 'notesStream' && m.message.id === note.id)!.message;
	expect(notes).not.toHaveProperty('type');
	expect(notes).toMatchObject({ text: '@bob reply', reply: { id: parent.id, repliesCount: 0 }, reactionAndUserPairCache: [] });
	expect(main('bob', 'mention')[0]).not.toHaveProperty('reactionAndUserPairCache');
	expect(main('bob', 'reply')[0]).toEqual(notes);
	await vi.waitFor(() => expect(main('bob', 'notification')).toHaveLength(1));
	expect(main('bob', 'notification')[0]).toMatchObject({ id: stored[0].notification_id, type: 'reply', userId: users.alice.id, user: { id: users.alice.id }, note: { id: note.id } });
	expect(main('bob', 'notification')[0]).not.toHaveProperty('targetNoteId');
	expect(Object.keys(main('bob', 'notification')[0]).sort()).toEqual(['createdAt', 'id', 'note', 'type', 'user', 'userId']);
	expect(main('bob', 'notification')[0].createdAt).toBe(stored[0].created_at.toISOString());
});
test('subscription and manager coexist; thread mute suppresses mention/reply only', async () => {
	await following('bob', 'alice', 'normal');
	const note = await create({ text: '@bob hello' });
	expect((await bodies(note.id)).map((n: any) => n.notification_type)).toEqual(['mention', 'note']);
	await resources.dataSource.getRepository(MiNoteThreadMuting).insert({ id: id(), userId: users.bob.id, threadId: note.id });
	const reply = await create({ text: '@bob reply', replyId: note.id });
	expect(await bodies(reply.id)).toEqual([]);
});
test('current follow/list/mute settings change which later posts are saved', async () => {
	await receive('bob', 'mention', 'following');
	expect(await bodies((await create({ text: '@bob first' })).id)).toEqual([]);
	await following('bob', 'alice');
	expect(await bodies((await create({ text: '@bob second' })).id)).toHaveLength(1);
	await resources.dataSource.getRepository(MiMuting).insert({ id: id(), muterId: users.bob.id, muteeId: users.alice.id, expiresAt: new Date(0) });
	expect(await bodies((await create({ text: '@bob third' })).id)).toEqual([]);
	await resources.dataSource.getRepository(MiMuting).delete({ muterId: users.bob.id });
	const listId = id();
	await resources.dataSource.getRepository(MiUserList).insert({ id: listId, userId: users.bob.id, name: 'allow' });
	await receive('bob', 'mention', 'list', { userListId: listId });
	expect(await bodies((await create({ text: '@bob fourth' })).id)).toEqual([]);
	await resources.dataSource.getRepository(MiUserListMembership).insert({ id: id(), userId: users.alice.id, userListId: listId, userListUserId: users.bob.id });
	expect(await bodies((await create({ text: '@bob fifth' })).id)).toHaveLength(1);
});
test('pure renote subscription mute does not suppress renote owner or quotes', async () => {
	const original = await create({ text: 'original' }, 'bob');
	await following('carol', 'alice', 'normal');
	await resources.dataSource.getRepository(MiRenoteMuting).insert({ id: id(), muterId: users.carol.id, muteeId: users.alice.id });
	const pure = await create({ renoteId: original.id });
	expect((await bodies(pure.id)).map((n: any) => [n.notification_type, n.target_note_id])).toEqual([['renote', original.id]]);
	const quote = await create({ text: 'quote', renoteId: original.id });
	expect((await bodies(quote.id)).map((n: any) => n.notification_type)).toEqual(['note', 'quote']);
	expect(main('bob', 'renote').map(n => n.id)).toEqual([pure.id, quote.id]);
});
test('specified raw producer event is unhidden; recipient detail still follows visibility', async () => {
	const note = await create({ text: '@bob secret', visibility: 'specified', visibleUserIds: [users.carol.id] });
	expect((await bodies(note.id)).map((n: any) => n.recipient_id)).toEqual([users.carol.id]);
	expect(messages.find(m => m.channel === 'notesStream' && m.message.id === note.id)!.message).toMatchObject({ text: '@bob secret', visibleUserIds: [users.carol.id] });
	expect(main('bob', 'mention')[0]).toMatchObject({ id: note.id, isHidden: true, text: null });
});
test('deletion publishes exact deleted payload even when later DB delete fails', async () => {
	const note = await create({ text: 'delete' });
	await resources.dataSource.query(`CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`);
	await resources.dataSource.query('CREATE TRIGGER refuse_delete BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION refuse_delete()');
	try {
		const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: users.alice.token, noteId: note.id }) });
		expect(response.status).toBe(500); await resources.notePostDelete.idle();
		await vi.waitFor(() => expect(messages.some(m => m.channel === `noteStream:${note.id}`)).toBe(true));
		expect(messages.find(m => m.channel === `noteStream:${note.id}`)).toEqual({ channel: `noteStream:${note.id}`, message: { type: 'deleted', body: { id: note.id, userId: users.alice.id, visibility: 'public', visibleUserIds: [], body: { deletedAt: expect.any(String) } } } });
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		const observed = messages.filter(m => m.channel === `noteStream:${note.id}`).map(m => JSON.parse(JSON.stringify(m).replaceAll(note.id, '$delete-target').replaceAll(users.alice.id, '$alice').replaceAll(m.message.body.body.deletedAt, '$time')));
		expect(observed).toEqual(golden['C10-deleted-stream']);
	} finally {
		await resources.dataSource.query('DROP TRIGGER refuse_delete ON note'); await resources.dataSource.query('DROP FUNCTION refuse_delete()');
	}
});
test('orphaned reply remains a reply and never becomes a subscribed note', async () => {
	const parent = await create({ text: 'parent' }, 'bob');
	const reply = await create({ text: 'reply', replyId: parent.id });
	await resources.dataSource.getRepository(MiNote).delete(parent.id);
	const facts = await createNoteNotificationReader(resources.dataSource.manager).read(reply.id);
	expect(facts?.reply).toEqual({ id: parent.id, userId: users.bob.id });
	await following('carol', 'alice', 'normal');
	expect(await createNoteNotificationReader(resources.dataSource.manager).readSubscribers(facts!)).toEqual([]);
});
test('poll-ended emits notification without user fields after PG save and schema matches synced entities', async () => {
	const note = await create({ text: 'poll', poll: { choices: ['a', 'b'] } });
	const logger = createLogger('notification-poll-worker', line => logs.push(line));
	const producer = createPollEndedQueue({ redis: database.config.redisForJobQueue, connectTimeoutMs: 5000, logger, onLost: () => { } });
	await producer.ready();
	const stop = await startPollEndedWorker({
		redis: database.config.redisForJobQueue, connectTimeoutMs: 5000, logger, reportFailure: error => {
			throw error;
		}, handle: createPollEndedHandler(resources, database.config)
	});
	try {
		await producer.schedule({ noteId: note.id, delayMs: 50 });
		await vi.waitFor(() => expect(main('alice', 'notification').some(n => n.type === 'pollEnded')).toBe(true), { timeout: 5000 });
	} finally {
		await stop(); await producer.close();
	}
	await vi.waitFor(() => expect(main('alice', 'notification').filter(n => n.type === 'pollEnded')).toHaveLength(1));
	const notification = main('alice', 'notification').find(n => n.type === 'pollEnded');
	expect(notification).toMatchObject({ type: 'pollEnded', note: { id: note.id } });
	expect(notification).not.toHaveProperty('user'); expect(notification).not.toHaveProperty('userId');
	expect(await bodies(note.id)).toHaveLength(1);
	await assertSchemaMatches(database.config.database);
});

test('notification publication failure retains committed body and HTTP success while other work continues', async () => {
	const original = resources.postingStream.main;
	const spy = vi.spyOn(resources.postingStream, 'main').mockImplementation((userId, type, value) => {
		if (type === 'notification') {
			return Promise.reject(new Error('injected notification publish'));
		}
		return original(userId, type, value);
	});
	try {
		const note = await create({ text: '@bob retained' });
		const rows = await bodies(note.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ notification_type: 'mention', note_id: note.id, recipient_id: users.bob.id, notifier_id: users.alice.id, target_note_id: null });
		expect(main('bob', 'mention').map(n => n.id)).toContain(note.id);
		expect(main('bob', 'notification')).toEqual([]);
		expect(logs.some(line => JSON.parse(line).event === 'note-post-save.failed')).toBe(true);
	} finally {
		spy.mockRestore();
	}
});
test('post-save suspended notifier suppresses publication after body save', async () => {
	const note = await create({ text: 'accepted' });
	await resources.dataSource.getRepository(MiNote).update(note.id, { mentions: [users.bob.id] });
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isSuspended: true });
	try {
		await resources.postingNotifications.createdEvents(async () => { })(note.id);
		expect((await bodies(note.id)).map((n: any) => n.notification_type)).toEqual(['mention']);
		expect(main('bob', 'notification')).toEqual([]);
	} finally {
		await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isSuspended: false });
	}
});

async function deferredCreate(input: object) {
	let saved!: NotePostSaveInput;
	const spy = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	try {
		const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users.alice.token, localOnly: true, ...input }) });
		expect(response.status).toBe(200);
		return { note: (await response.json()).createdNote, saved };
	} finally {
		spy.mockRestore();
	}
}

test('saved note and related counters survive mutation/deletion before deferred publication', async () => {
	const parent = await create({ text: 'parent' }, 'bob');
	const { note, saved } = await deferredCreate({ text: 'snapshot reply', replyId: parent.id });
	await resources.dataSource.getRepository(MiNote).increment({ id: parent.id }, 'repliesCount', 17);
	await resources.dataSource.getRepository(MiNote).delete(note.id);
	const publish = resources.postingNotifications.createdEvents(async () => { });
	await expect(publish(note.id, saved)).rejects.toThrow();
	await vi.waitFor(() => expect(messages.some(m => m.channel === 'notesStream' && m.message.id === note.id)).toBe(true));
	expect(messages.find(m => m.channel === 'notesStream' && m.message.id === note.id)!.message).toMatchObject({ text: 'snapshot reply', reply: { repliesCount: 0 } });
	expect((await bodies(note.id)).map((n: any) => n.notification_type)).toEqual(['reply']);
});
test('snapshot Note rendering reads current poll votes for the recipient and fails when Poll was deleted', async () => {
	const { note, saved } = await deferredCreate({ text: '@bob poll', poll: { choices: ['a', 'b'], multiple: false } });
	await resources.dataSource.getRepository(MiPoll).update(note.id, { votes: [0, 1] });
	await resources.dataSource.getRepository(MiPollVote).insert({ id: id(), noteId: note.id, userId: users.bob.id, choice: 1 });
	await resources.postingNotifications.createdEvents(async () => { })(note.id, saved);
	await vi.waitFor(() => expect(main('bob', 'mention').some(n => n.id === note.id)).toBe(true));
	expect(main('bob', 'mention').find(n => n.id === note.id).poll.choices).toEqual([{ text: 'a', votes: 0, isVoted: false }, { text: 'b', votes: 1, isVoted: true }]);
	const second = await deferredCreate({ text: '@bob missing poll', poll: { choices: ['a', 'b'] } });
	await resources.dataSource.getRepository(MiPoll).delete(second.note.id);
	let delivered = false;
	await expect(resources.postingNotifications.createdEvents(async () => {
		delivered = true;
	})(second.note.id, second.saved)).rejects.toThrow();
	expect(delivered).toBe(false);
	expect(messages.some(m => m.channel === 'notesStream' && m.message.id === second.note.id)).toBe(false);
});
test('subscription selection does not filter existing normal notify rows by follower host', async () => {
	const remote = id();
	await resources.dataSource.getRepository(MiUser).insert({ id: remote, username: 'remoteSubscriber', usernameLower: 'remotesubscriber', host: 'remote.example' });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: remote, userHost: 'remote.example' });
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: remote, followeeId: users.alice.id, followerHost: 'remote.example', notify: 'normal' });
	const note = await create({ text: 'subscribed' });
	expect((await bodies(note.id)).map((n: any) => [n.recipient_id, n.notification_type])).toEqual([[remote, 'note']]);
});
