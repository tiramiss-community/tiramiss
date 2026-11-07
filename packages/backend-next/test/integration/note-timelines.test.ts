/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiChannel, MiChannelFollowing, MiFollowing, MiMeta, MiNote, MiUser, MiUserList, MiUserListMembership } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import type { NotePostSaveInput } from '../../src/modules/note/public.js';
import { createNoteTimelineReader } from '../../src/platform/database/note-timelines.js';
import { createPostingTimelines } from '../../src/composition/posting-timelines.js';
import { createTimelineCache } from '../../src/platform/timeline-cache.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let timelineRedis: Redis;
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const users: Record<string, { id: string; token: string }> = {};
const logs: string[] = [];
const list = (name: string) => timelineRedis.lrange(`list:${name}`, 0, -1);

async function create(input: object = {}, name = 'alice') {
	const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users[name].token, text: 'timeline', localOnly: true, ...input }) });
	expect(response.status).toBe(200);
	const result = await response.json();
	await resources.notePostSave.idle();
	return result.createdNote;
}

async function following(follower: string, extra = {}) {
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: users[follower].id, followeeId: users.alice.id, ...extra });
}

async function userList(owner: string) {
	const value = id();
	await resources.dataSource.getRepository(MiUserList).insert({ id: value, userId: users[owner].id, name: 'timeline' });
	await resources.dataSource.getRepository(MiUserListMembership).insert({ id: id(), userListId: value, userListUserId: users[owner].id, userId: users.alice.id });
	return value;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	// 別db/prefixへ書くことでredisForTimelinesとbase Redisの取り違えも観測する。
	database.config.redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-tl`, keyPrefix: `${database.config.redis.prefix}-tl:` };
	resources = await connectResources(database.config, createLogger('timelines-test', line => logs.push(line)));
	timelineRedis = new Redis(database.config.redisForTimelines);
	for (const name of ['alice', 'bob', 'carol', 'dormant', 'remote']) {
		users[name] = { id: id(), token: `tl${name.padEnd(14, '0')}` };
		await resources.dataSource.getRepository(MiUser).insert({ ...users[name], username: name, usernameLower: name, host: name === 'remote' ? 'remote.test' : null });
	}
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	app = createBackendHttpApp(resources, database.config);
});
beforeEach(async () => {
	await resources.notePostSave.idle();
	await resources.notePostDelete.idle();
	await resources.dataSource.query('TRUNCATE following, user_list, channel_following CASCADE');
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true, perUserHomeTimelineCacheMax: 300 });
	await resources.dataSource.getRepository(MiUser).createQueryBuilder().update().set({ isHibernated: false, lastActiveDate: null }).execute();
	for (const key of await timelineRedis.keys(`${database.config.redisForTimelines!.keyPrefix}list:*`)) {
		await timelineRedis.del(key.slice(database.config.redisForTimelines!.keyPrefix!.length));
	}
	logs.length = 0;
});
afterAll(async () => {
	timelineRedis?.disconnect();
	await resources?.close();
	await database?.close();
});
test('ordinary HTTP fanout reaches local/user/home/list and skips remote or dormant followers', async () => {
	await following('bob');
	await following('dormant', { isFollowerHibernated: true });
	await following('remote', { followerHost: 'remote.test' });
	const own = await userList('alice');
	const followed = await userList('bob');
	const dormant = await userList('dormant');
	const note = await create({ visibility: 'followers' });
	expect(await list(`homeTimeline:${users.bob.id}`)).toContain(note.id);
	expect(await list(`homeTimeline:${users.alice.id}`)).toContain(note.id);
	expect(await list(`userTimeline:${users.alice.id}`)).toContain(note.id);
	expect(await list(`userListTimeline:${own}`)).toContain(note.id);
	expect(await list(`userListTimeline:${followed}`)).toContain(note.id);
	expect(await list(`userListTimeline:${dormant}`)).toEqual([]);
	expect(await list(`homeTimeline:${users.dormant.id}`)).toEqual([]);
	expect(await list(`homeTimeline:${users.remote.id}`)).toEqual([]);
	expect(await list('localTimeline')).toEqual([]);
	expect(await resources.redis.lrange(`list:userTimeline:${users.alice.id}`, 0, -1)).toEqual([]);
	const publicNote = await create();
	expect(await list('localTimeline')).toContain(publicNote.id);
});
test('reply routing and current follow/list settings are used for each later post', async () => {
	await following('bob');
	await following('carol', { withReplies: true });
	const parent = await create({ text: 'parent' }, 'bob');
	const reply = await create({ replyId: parent.id });
	expect(await list(`homeTimeline:${users.bob.id}`)).toContain(reply.id);
	expect(await list(`homeTimeline:${users.carol.id}`)).toContain(reply.id);
	expect(await list(`userTimelineWithReplies:${users.alice.id}`)).toContain(reply.id);
	expect(await list('localTimelineWithReplies')).toContain(reply.id);
	expect(await list(`localTimelineWithReplyTo:${users.bob.id}`)).toContain(reply.id);
	await resources.dataSource.getRepository(MiFollowing).delete({ followerId: users.carol.id });
	const next = await create();
	expect(await list(`homeTimeline:${users.carol.id}`)).not.toContain(next.id);
});
test('channel subscribers bypass ordinary host/hibernation filters and schema matches the mechanical sync', async () => {
	const channel = id();
	await resources.dataSource.getRepository(MiChannel).insert({ id: channel, userId: users.alice.id, name: 'channel' });
	await resources.dataSource.getRepository(MiChannelFollowing).insert({ id: id(), followeeId: channel, followerId: users.remote.id });
	await resources.dataSource.getRepository(MiUser).update(users.remote.id, { isHibernated: true });
	const note = await create({ channelId: channel });
	expect(await list(`channelTimeline:${channel}`)).toContain(note.id);
	expect(await list(`userTimelineWithChannel:${users.alice.id}`)).toContain(note.id);
	expect(await list(`homeTimeline:${users.remote.id}`)).toContain(note.id);
	expect(await list('localTimeline')).not.toContain(note.id);
	await assertSchemaMatches(database.config.database);
});
test('disabled fanout writes nothing and later Meta changes take effect', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: false });
	const note = await create();
	expect(await list('localTimeline')).not.toContain(note.id);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true });
	const next = await create();
	expect(await list('localTimeline')).toContain(next.id);
});
test('deletion leaves cached IDs, including delayed post-save insertion from the saved snapshot', async () => {
	let saved!: NotePostSaveInput;
	const spy = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let note: { id: string };
	try {
		note = await create();
	} finally {
		spy.mockRestore();
	}
	const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: users.alice.token, noteId: note.id }) });
	expect(response.status).toBe(204);
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(false);
	expect(await list('localTimeline')).toContain(note.id);
});
test('one Redis WRONGTYPE does not undo HTTP success or skip other keys and logs failure', async () => {
	await timelineRedis.set(`list:homeTimeline:${users.alice.id}`, 'wrongtype');
	const note = await create();
	expect(await list(`userTimeline:${users.alice.id}`)).toContain(note.id);
	expect(await list('localTimeline')).toContain(note.id);
	expect(logs.some(line => JSON.parse(line).event === 'note-post-save.failed')).toBe(true);
});
test('sampled inactive follower is included once then all its followings are marked dormant', async () => {
	await following('dormant');
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: users.dormant.id, followeeId: users.carol.id });
	await resources.dataSource.getRepository(MiUser).update(users.dormant.id, { lastActiveDate: new Date(Date.now() - 51 * 86400000) });
	const random = vi.spyOn(Math, 'random').mockReturnValue(0.01);
	try {
		const note = await create();
		expect(await list(`homeTimeline:${users.dormant.id}`)).toContain(note.id);
		expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.dormant.id })).isHibernated).toBe(true);
		expect((await resources.dataSource.getRepository(MiFollowing).findBy({ followerId: users.dormant.id })).every(row => row.isFollowerHibernated)).toBe(true);
		const next = await create();
		expect(await list(`homeTimeline:${users.dormant.id}`)).not.toContain(next.id);
	} finally {
		random.mockRestore();
	}
});

test('hibernation excludes the exact 50-day boundary and null activity dates', async () => {
	const now = Date.now();
	await resources.dataSource.getRepository(MiUser).update(users.bob.id, { lastActiveDate: new Date(now - 50 * 86400000) });
	await resources.dataSource.getRepository(MiUser).update(users.carol.id, { lastActiveDate: new Date(now - 50 * 86400000 - 1) });
	await createNoteTimelineReader(resources.dataSource.manager, 1000).hibernate([users.bob.id, users.carol.id, users.dormant.id], now);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.bob.id })).isHibernated).toBe(false);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.carol.id })).isHibernated).toBe(true);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.dormant.id })).isHibernated).toBe(false);
});

test('old channel direct writes survive later recipient-query failure, recent buffered writes do not', async () => {
	const now = Date.now();
	const reader = createNoteTimelineReader(resources.dataSource.manager, 1000);
	vi.spyOn(reader, 'channelFollowers').mockRejectedValue(new Error('injected query failure'));
	const run = createPostingTimelines({ reader, cache: createTimelineCache(resources.timelinesRedis, { createdAtFromId: codec.createdAtFromId, currentTime: () => now, random: () => 0 }), currentTime: () => now, random: () => 0 });
	const saved = (noteId: string): NotePostSaveInput => ({ noteId, userId: users.alice.id, repliedNoteId: null, renotedNoteId: null, channelId: 'failure-channel', pollExpiresAtMs: null, createdSnapshot: {
		note: { id: noteId, userId: users.alice.id, userHost: null, text: 'saved', cw: null, visibility: 'public', localOnly: true, reactionAcceptance: null, channelId: 'failure-channel', fileIds: [], attachedFileTypes: [], hasPoll: false, replyId: null, renoteId: null, threadId: null, replyUserId: null, replyUserHost: null, renoteUserId: null, renoteUserHost: null, renoteChannelId: null, visibleUserIds: [], mentions: [], mentionedRemoteUsers: [], tags: [], emojis: [] }, reply: null, renote: null,
	} });
	const old = codec.newId(now - 240000);
	await expect(run(saved(old))).rejects.toThrow('injected query failure');
	expect(await list('channelTimeline:failure-channel')).toEqual([old]);
	expect(await list(`userTimelineWithChannel:${users.alice.id}`)).toEqual([old]);
	const recent = codec.newId(now);
	await expect(run(saved(recent))).rejects.toThrow('injected query failure');
	expect(await list('channelTimeline:failure-channel')).toEqual([old]);
});

test('fractional file-cache trim errors keep the inserted IDs and report the failed command', async () => {
	const now = Date.now();
	const note = codec.newId(now);
	const batch = createTimelineCache(resources.timelinesRedis, { createdAtFromId: codec.createdAtFromId, currentTime: () => now, random: () => 0 }).begin(note);
	batch.push({ name: 'homeTimelineWithFiles:odd-max', maxlen: 150.5 });
	await expect(batch.flush()).rejects.toThrow('Timeline cache update failed');
	expect(await list('homeTimelineWithFiles:odd-max')).toEqual([note]);
});
