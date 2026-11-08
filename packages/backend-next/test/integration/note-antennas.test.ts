/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiAntenna, MiChannel, MiDriveFile, MiFollowing, MiMeta, MiNote, MiUser, MiUserList, MiUserListMembership, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { createPostingAntennas } from '../../src/composition/posting-antennas.js';
import { createNoteWriter } from '../../src/platform/database/note-writer.js';
import { createNoteAntennaReader } from '../../src/platform/database/note-antennas.js';
import { createTimelineCache } from '../../src/platform/timeline-cache.js';
import { createHostRules } from '../../src/modules/federation/public.js';
import type { NewNote, NotePostSaveInput } from '../../src/modules/note/public.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let timeline: Redis, subscriber: Redis;
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const users: Record<string, {
	id: string;
	token: string;
}> = {};
const logs: string[] = [];
const messages: {
	channel: string;
	message: {
		type: string;
		body: Record<string, unknown>;
	};
}[] = [];
const list = (antennaId: string) => timeline.lrange(`list:antennaTimeline:${antennaId}`, 0, -1);
const received = (antennaId: string, noteId: string) => messages.find(value => value.channel === `antennaStream:${antennaId}` && value.message.body.id === noteId)?.message.body;

async function internal(type: string, body: object) {
	await resources.redis.publish(new URL(database.config.url).host, JSON.stringify({ channel: 'internal', message: { type, body } }));
	await vi.waitFor(() => expect(messages.some(value => value.channel === 'internal' && value.message.type === type && JSON.stringify(value.message.body) === JSON.stringify(body))).toBe(true));
	// Every subscriber receives the event independently; observe the producer cache as the receipt barrier.
	if (type === 'antennaDeleted') {
		await vi.waitFor(async () => expect((await resources.noteAntennas.definitions()).some(value => value.id === (body as {
			id: string;
		}).id)).toBe(false));
	}
	if (type === 'antennaCreated' || type === 'antennaUpdated') {
		await vi.waitFor(async () => expect(await resources.noteAntennas.definitions()).toContainEqual(expect.objectContaining(body)));
	}
}

async function antenna(extra: Partial<MiAntenna> = {}) {
	const key = id();
	await resources.dataSource.getRepository(MiAntenna).insert({
		id: key, userId: users.bob.id, name: 'antenna', src: 'all', withFile: false, withReplies: true, lastUsedAt: new Date(), keywords: [], excludeKeywords: [], users: [], ...extra
	});
	const row = await resources.dataSource.getRepository(MiAntenna).findOneByOrFail({ id: key });
	const plain = JSON.parse(JSON.stringify(row));
	await internal('antennaCreated', plain);
	return row;
}

async function create(input: object = {}, name = 'alice') {
	const response = await app.request('/api/notes/create', {
		method: 'POST', body: JSON.stringify({
			i: users[name].token, text: 'Hello', localOnly: true, ...input
		})
	});
	expect(response.status, await response.clone().text()).toBe(200);
	const note = (await response.json()).createdNote;
	await resources.notePostSave.idle();
	return note;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.redisForTimelines = {
		...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-tl`, keyPrefix: `${database.config.redis.prefix}-tl:`
	};
	const source = await createDataSource(database.config.database).initialize();
	for (const name of ['alice', 'bob', 'carol', 'remote']) {
		users[name] = { id: id(), token: `an${name.padEnd(14, '0')}` };
		await source.getRepository(MiUser).insert({
			...users[name], lastFetchedAt: name === 'remote' ? new Date() : null, username: name === 'remote' ? 'Other' : name, usernameLower: name === 'remote' ? 'other' : name, host: name === 'remote' ? 'remote.example' : null, uri: name === 'remote' ? 'https://remote.example/users/other' : null
		});
		await source.getRepository(MiUserProfile).insert({ userId: users[name].id, url: name === 'remote' ? 'https://remote.example/profile' : null });
	}
	await source.getRepository(MiMeta).insert({ id: 'singleton' });
	// Bootstrap rows prove active filtering before any internal event or first lookup.
	await source.getRepository(MiAntenna).insert([{
		id: 'bootstrap-active', userId: users.bob.id, name: 'active', src: 'all', withFile: false, withReplies: true, lastUsedAt: new Date(), isActive: true
	}, {
		id: 'bootstrap-inactive', userId: users.bob.id, name: 'inactive', src: 'all', withFile: false, withReplies: true, lastUsedAt: new Date(), isActive: false
	}]);
	await source.destroy();
	resources = await connectResources(database.config, createLogger('antenna-test', line => logs.push(line)));
	timeline = new Redis(database.config.redisForTimelines);
	subscriber = new Redis(database.config.redisForPubsub);
	subscriber.on('message', (_topic, encoded) => {
		messages.push(JSON.parse(encoded));
	});
	await subscriber.subscribe(new URL(database.config.url).host);
	app = createBackendHttpApp(resources, database.config);
});
beforeEach(async (context) => {
	await resources.notePostSave.idle();
	await resources.notePostDelete.idle();
	if (!context.task.name.startsWith('initial')) {
		for (const item of await resources.noteAntennas.definitions()) {
			await internal('antennaDeleted', { id: item.id });
		}
	}
	await resources.dataSource.query('DELETE FROM following');
	await resources.dataSource.query('DELETE FROM user_list');
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isBot: false });
	await internal('follow', { followerId: users.bob.id, followeeId: users.alice.id });
	await vi.waitFor(async () => expect(await resources.redis.exists(`kvcache:userFollowings:${users.bob.id}`)).toBe(0));
	messages.length = 0;
	logs.length = 0;
});
afterAll(async () => {
	subscriber?.disconnect();
	timeline?.disconnect();
	await resources?.close();
	await database?.close();
});
test('initial active-only query is lazy and later database-only changes do not replace the resident list', async () => {
	const note = await create();
	expect(await list('bootstrap-active')).toContain(note.id);
	expect(await list('bootstrap-inactive')).toEqual([]);
	await resources.dataSource.getRepository(MiAntenna).update('bootstrap-active', { isActive: false });
	const next = await create();
	expect(await list('bootstrap-active')).toContain(next.id);
	expect(await resources.redis.lrange('list:antennaTimeline:bootstrap-active', 0, -1)).toEqual([]);
});
test.each(['public', 'home', 'followers', 'specified'] as const)('HTTP %s audience and real following/list membership select all eligible owners', async (visibility) => {
	const bob = await antenna();
	const own = await antenna({ userId: users.alice.id });
	const carol = await antenna({ userId: users.carol.id });
	await resources.dataSource.getRepository(MiFollowing).insert({
		id: id(), followerId: users.bob.id, followeeId: users.alice.id, withReplies: false, isFollowerHibernated: true
	});
	const note = await create({ visibility, visibleUserIds: [users.bob.id] });
	expect(await list(bob.id)).toContain(note.id);
	expect(await list(own.id)).toContain(note.id);
	expect((await list(carol.id)).includes(note.id)).toBe(visibility === 'public' || visibility === 'home');
	if (visibility === 'followers') {
		expect(await resources.redis.ttl(`kvcache:userFollowings:${users.bob.id}`)).toBeGreaterThan(1790);
		expect(JSON.parse((await resources.redis.get(`kvcache:userFollowings:${users.bob.id}`))!)).toEqual({ [users.alice.id]: { withReplies: false } });
	}
});
test('list membership is read fresh while home source retains the upstream TODO behavior', async () => {
	const listId = id();
	await resources.dataSource.getRepository(MiUserList).insert({ id: listId, userId: users.carol.id, name: 'list' });
	const a = await antenna({ src: 'list', userListId: listId });
	const home = await antenna({ src: 'home' });
	const first = await create();
	expect(await list(a.id)).not.toContain(first.id);
	expect(await list(home.id)).toContain(first.id);
	await resources.dataSource.getRepository(MiUserListMembership).insert({
		id: id(), userListId: listId, userListUserId: users.carol.id, userId: users.alice.id
	});
	const second = await create();
	expect(await list(a.id)).toContain(second.id);
	await resources.dataSource.getRepository(MiUserListMembership).delete({ userListId: listId });
	const third = await create();
	expect(await list(a.id)).not.toContain(third.id);
});
test('internal inactive create/update/upsert/delete affect subsequent posts without antenna API endpoints', async () => {
	const a = await antenna({ isActive: false });
	const first = await create();
	expect(await list(a.id)).toContain(first.id);
	await internal('antennaUpdated', { ...JSON.parse(JSON.stringify(a)), keywords: [['changed']], isActive: false });
	const second = await create();
	expect(await list(a.id)).not.toContain(second.id);
	const third = await create({ text: 'changed' });
	expect(await list(a.id)).toContain(third.id);
	await internal('antennaDeleted', { id: a.id });
	const fourth = await create({ text: 'changed' });
	expect(await list(a.id)).not.toContain(fourth.id);
	await internal('antennaUpdated', JSON.parse(JSON.stringify(a)));
	const fifth = await create();
	expect(await list(a.id)).toContain(fifth.id);
});
test('follow invalidates both cache layers; database-only follow and unfollow leave the cached membership', async () => {
	const a = await antenna();
	const first = await create({ visibility: 'followers' });
	expect(await list(a.id)).not.toContain(first.id);
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: users.bob.id, followeeId: users.alice.id });
	const second = await create({ visibility: 'followers' });
	expect(await list(a.id)).not.toContain(second.id);
	await internal('unfollow', { followerId: users.bob.id });
	const third = await create({ visibility: 'followers' });
	expect(await list(a.id)).not.toContain(third.id);
	await internal('follow', { followerId: users.bob.id });
	await vi.waitFor(async () => expect(await resources.redis.exists(`kvcache:userFollowings:${users.bob.id}`)).toBe(0));
	const fourth = await create({ visibility: 'followers' });
	expect(await list(a.id)).toContain(fourth.id);
	await resources.dataSource.getRepository(MiFollowing).delete({ followerId: users.bob.id });
	const fifth = await create({ visibility: 'followers' });
	expect(await list(a.id)).toContain(fifth.id);
});
test('corrected inherited sensitive channel and captured bot facts are used after save', async () => {
	const a = await antenna({ excludeNotesInSensitiveChannel: true });
	const bots = await antenna({ excludeBots: true });
	const all = await antenna();
	const channelId = id();
	await resources.dataSource.getRepository(MiChannel).insert({
		id: channelId, userId: users.alice.id, name: 'sensitive', isSensitive: true
	});
	const parent = await create({ channelId });
	await resources.dataSource.getRepository(MiChannel).update(channelId, { isArchived: true });
	let saved!: NotePostSaveInput;
	const hold = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let reply: {
		id: string;
	};
	try {
		reply = await create({ replyId: parent.id });
	} finally {
		hold.mockRestore();
	}
	await resources.dataSource.getRepository(MiChannel).update(channelId, { isSensitive: false, name: 'later' });
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isBot: true, username: 'later' });
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	expect(await list(a.id)).not.toContain(reply.id);
	expect(await list(bots.id)).toContain(reply.id);
	expect(await list(all.id)).toContain(reply.id);
	await vi.waitFor(() => expect(received(all.id, reply.id)).toBeDefined());
	expect(received(all.id, reply.id)?.channel).toMatchObject({
		id: channelId, name: 'sensitive', isSensitive: true, isArchived: true
	});
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { username: 'alice' });
	const botNote = await create();
	expect(await list(bots.id)).not.toContain(botNote.id);
});
test('files, keyword CW/newline, replies and pure renote use their own persisted body', async () => {
	const files = await antenna({ withFile: true });
	const cw = await antenna({ keywords: [['hello\nwarning']] });
	const replies = await antenna({ withReplies: false });
	const targetOnly = await antenna({ keywords: [['target']] });
	const file = id();
	await resources.dataSource.getRepository(MiDriveFile).insert({
		id: file, userId: users.alice.id, name: 'file.png', storedInternal: false, type: 'image/png', md5: '0'.repeat(32), size: 1, url: 'https://example.test/file.png'
	});
	const withFile = await create({ text: 'hello', cw: 'warning', fileIds: [file] });
	expect(await list(files.id)).toContain(withFile.id);
	expect(await list(cw.id)).toContain(withFile.id);
	const parent = await create({ text: 'target' });
	const reply = await create({ replyId: parent.id });
	expect(await list(replies.id)).not.toContain(reply.id);
	const renote = await create({ text: null, renoteId: parent.id });
	expect(await list(targetOnly.id)).not.toContain(renote.id);
});
test('WRONGTYPE timeline preserves HTTP success, sibling lists, raw publications and diagnostics', async () => {
	const a = await antenna();
	const b = await antenna();
	await timeline.set(`list:antennaTimeline:${a.id}`, 'wrong');
	const note = await create();
	expect(await list(b.id)).toContain(note.id);
	await vi.waitFor(() => expect(received(a.id, note.id)).toBeDefined());
	expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-save.failed', error: expect.objectContaining({ details: { failures: expect.arrayContaining([expect.objectContaining({ step: 'antennas' })]) } }) }));
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
});
test('publication rejection does not suppress the sibling pipeline or other post-save delivery', async () => {
	const a = await antenna();
	const publish = vi.spyOn(resources.postingStream, 'antenna').mockRejectedValue(new Error('publication'));
	// Composition has captured the original publisher; inject at the connection to exercise the actual configured publication port.
	const reader = createNoteAntennaReader(resources.dataSource.manager);
	const run = createPostingAntennas({
		...resources.noteAntennas, listContains: reader.listContains, fullApAccount: createHostRules('example.test').fullApAccount, cache: createTimelineCache(timeline, { createdAtFromId: codec.createdAtFromId, currentTime: Date.now, random: () => 0 }), publish
	});
	let saved!: NotePostSaveInput;
	const start = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let note: {
		id: string;
	};
	try {
		note = await create();
	} finally {
		start.mockRestore();
	}
	await expect(run(saved)).rejects.toThrow('Antenna output failed');
	expect(await list(a.id)).toContain(note.id);
	publish.mockRestore();
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	expect(await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.alice.id })).toMatchObject({ notesCount: expect.any(Number) });
});
test('list lookup rejection suppresses all antenna outputs and still permits the independent ordinary timeline', async () => {
	const a = await antenna();
	const l = id();
	await resources.dataSource.getRepository(MiUserList).insert({ id: l, userId: users.bob.id, name: 'reject' });
	await antenna({ src: 'list', userListId: l });
	const reader = createNoteAntennaReader(resources.dataSource.manager);
	const manager = resources.dataSource.manager;
	const repository = manager.getRepository(MiUserListMembership);
	const spy = vi.spyOn(repository, 'existsBy').mockRejectedValue(new Error('lookup'));
	const note = await create();
	spy.mockRestore();
	expect(await list(a.id)).not.toContain(note.id);
	expect(received(a.id, note.id)).toBeUndefined();
	expect(await timeline.lrange(`list:userTimeline:${users.alice.id}`, 0, -1)).toContain(note.id);
	expect(reader).toBeDefined();
});
test('post-save captured raw publication remains after immediate deletion, without purge or reread', async () => {
	const a = await antenna();
	let saved!: NotePostSaveInput;
	const start = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let note: {
		id: string;
	};
	try {
		note = await create();
	} finally {
		start.mockRestore();
	}
	const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: users.alice.token, noteId: note.id }) });
	expect(response.status).toBe(204);
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	expect(await list(a.id)).toContain(note.id);
	await vi.waitFor(() => expect(received(a.id, note.id)).toBeDefined());
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(false);
});
test('HTTP raw inserted body exactly matches actual fixed-source PostgreSQL shape, including missing URI/name versus null related columns', async () => {
	const a = await antenna();
	const corpus = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/antenna/source-observations.json', import.meta.url), 'utf8')) as {
		observations: {
			id: string;
			publication: Record<string, unknown>;
		}[];
	};
	const basic = corpus.observations.find(value => value.id === 'payload-actual-pg-basic')!.publication;
	const created = await create();
	await vi.waitFor(() => expect(received(a.id, created.id)).toBeDefined());
	expect(received(a.id, created.id)).toEqual({
		...basic, id: created.id, userId: users.alice.id, tags: []
	});
	const reply = await create({ replyId: created.id });
	await vi.waitFor(() => expect(received(a.id, reply.id)).toBeDefined());
	const rawReply = received(a.id, reply.id)!;
	expect(rawReply).not.toHaveProperty('name');
	expect(rawReply).not.toHaveProperty('uri');
	expect(rawReply.reply).toEqual({
		...basic, id: created.id, userId: users.alice.id, tags: [], name: null, uri: null, url: null, reply: undefined, renote: undefined, channel: undefined
	});
	const mention = await create({ text: '@Other@remote.example' });
	await vi.waitFor(() => expect(received(a.id, mention.id)).toBeDefined());
	expect(received(a.id, mention.id)?.mentionedRemoteUsers).toBe('[{"uri":"https://remote.example/users/other","url":"https://remote.example/profile","username":"Other","host":"remote.example"}]');
});
const sourcePayloads = (JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/antenna/source-observations.json', import.meta.url), 'utf8')) as {
	observations: {
		id: string;
		input: {
			data: {
				reply?: Record<string, unknown>;
				renote?: Record<string, unknown>;
				channel?: Record<string, unknown>;
			};
		};
		publication: Record<string, unknown>;
	}[];
}).observations.filter(row => row.id.startsWith('payload-actual-pg-'));
test.each(sourcePayloads)('actual PostgreSQL persistence boundary and Redis full body directly match fixed source: $id', async (row) => {
	const expected = row.publication;
	const source = resources.dataSource;
	if (!await source.getRepository(MiUser).existsBy({ id: 'author' })) {
		await source.getRepository(MiUser).insert({ id: 'author', username: 'Alice', usernameLower: 'alice-oracle' });
	}
	const target = row.input.data.reply ?? row.input.data.renote;
	if (target && !await source.getRepository(MiNote).existsBy({ id: String(target.id) })) {
		await source.getRepository(MiNote).insert(target);
	}
	if (row.input.data.channel && !await source.getRepository(MiChannel).existsBy({ id: 'channel' })) {
		await source.getRepository(MiChannel).insert(row.input.data.channel);
	}
	const note = Object.fromEntries(['id', 'userId', 'userHost', 'text', 'cw', 'visibility', 'localOnly', 'reactionAcceptance', 'channelId', 'fileIds', 'attachedFileTypes', 'hasPoll', 'replyId', 'renoteId', 'threadId', 'replyUserId', 'replyUserHost', 'renoteUserId', 'renoteUserHost', 'renoteChannelId', 'visibleUserIds', 'mentions', 'tags', 'emojis'].map(key => [key, expected[key]])) as unknown as NewNote;
	note.mentionedRemoteUsers = JSON.parse(String(expected.mentionedRemoteUsers));
	const writer = createNoteWriter(source.manager, resources.roleMaterials, Number);
	const raw = await writer.writes.insertNote(note);
	const reply = note.replyId === null ? null : await writer.readNote(note.replyId);
	const renote = note.renoteId === null ? null : await writer.readNote(note.renoteId);
	const channel = note.channelId === null ? null : await writer.readChannel(note.channelId, { includeArchived: true });
	const a = await antenna();
	const run = createPostingAntennas({
		definitions: async () => [a], followingIds: resources.noteAntennas.followingIds, listContains: async () => true, fullApAccount: createHostRules('local.example').fullApAccount,
		cache: createTimelineCache(timeline, { createdAtFromId: Number, currentTime: () => Number(note.id), random: () => 1 }), publish: resources.postingStream.antenna
	});
	await run({
		noteId: note.id, userId: note.userId, repliedNoteId: note.replyId, renotedNoteId: null, channelId: note.channelId, pollExpiresAtMs: null, createdSnapshot: {
			note, author: {
				id: 'author', username: 'Alice', host: null, isBot: false
			}, channel, reply, renote, rawNote: { ...raw, reply: reply?.rawNote ?? null, renote: renote?.rawNote ?? null }
		}
	});
	await vi.waitFor(() => expect(received(a.id, note.id)).toBeDefined());
	expect(received(a.id, note.id)).toEqual(expected);
	expect(await list(a.id)).toEqual([note.id]);
});
test.each(['notesCount', 'lastNotedAt'] as const)('channel SQL %s failure leaves the other statement and usersCount independent', async (column) => {
	const channelId = id();
	await resources.dataSource.getRepository(MiChannel).insert({ id: channelId, userId: users.alice.id, name: 'failure' });
	// Separate column triggers distinguish three source statements from one combined UPDATE.
	const fn = `reject_channel_${column.toLowerCase()}_${channelId}`;
	await resources.dataSource.query(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected channel update'; END $$`);
	await resources.dataSource.query(`CREATE TRIGGER reject_channel BEFORE UPDATE OF "${column}" ON channel FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
	try {
		await create({ channelId });
		const channel = await resources.dataSource.getRepository(MiChannel).findOneByOrFail({ id: channelId });
		expect(channel.notesCount).toBe(column === 'notesCount' ? 0 : 1);
		expect(channel.lastNotedAt === null).toBe(column === 'lastNotedAt');
		expect(channel.usersCount).toBe(1);
		expect(logs.some(line => JSON.parse(line).event === 'note-post-save.failed')).toBe(true);
	} finally {
		await resources.dataSource.query('DROP TRIGGER reject_channel ON channel');
		await resources.dataSource.query(`DROP FUNCTION "${fn}"()`);
	}
});
test('post-save packed render failure leaves independent antenna timeline and raw stream publication intact', async () => {
	const a = await antenna();
	let saved!: NotePostSaveInput;
	const start = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let note: {
		id: string;
	};
	try {
		note = await create();
	} finally {
		start.mockRestore();
	}
	const pack = vi.spyOn(resources.dataSource.getRepository(MiUser), 'find').mockRejectedValue(new Error('pack material unavailable'));
	try {
		resources.notePostSave.start(saved);
		await resources.notePostSave.idle();
	} finally {
		pack.mockRestore();
	}
	expect(await list(a.id)).toContain(note.id);
	await vi.waitFor(() => expect(received(a.id, note.id)).toBeDefined());
	expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-save.failed', error: expect.objectContaining({ details: { failures: expect.arrayContaining([expect.objectContaining({ step: 'deliver' })]) } }) }));
});
test('actual Redis subscriber normal close and subscribe rejection release their dedicated named connections', async () => {
	const { openNoteAntennas } = await import('../../src/platform/note-antennas.js');
	const reader = createNoteAntennaReader(resources.dataSource.manager);
	const name = `antenna-close-${id()}`;
	const subscriberConfig = { ...database.config.redisForPubsub, connectionName: name };
	const options = {
		reader, redis: resources.redis, subscriberConfig, url: database.config.url, timeoutMs: 1000, currentTime: Date.now, onError: () => { }
	};
	const opened = await openNoteAntennas(options);
	expect(String(await resources.redis.client('LIST'))).toContain(`name=${name}`);
	await opened.close();
	await vi.waitFor(async () => expect(String(await resources.redis.client('LIST'))).not.toContain(`name=${name}`));
	const username = `antenna-${id()}`;
	await resources.redis.call('ACL', 'SETUSER', username, 'on', '>antenna-test-password', '+@connection', '+info', '-subscribe', '-psubscribe');
	const cleanups: (() => Promise<void>)[] = [];
	try {
		await expect(openNoteAntennas({
			...options, subscriberConfig: { ...subscriberConfig, username, password: 'antenna-test-password' }, registerCleanup: close => {
				cleanups.push(close);
			}
		})).rejects.toThrow(/NOPERM/);
		expect(cleanups).toHaveLength(1);
		await cleanups[0]();
		await vi.waitFor(async () => expect(String(await resources.redis.client('LIST'))).not.toContain(`name=${name}`));
	} finally {
		await resources.redis.call('ACL', 'DELUSER', username);
	}
});
