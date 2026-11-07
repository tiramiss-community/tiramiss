/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiChannel, MiMeta, MiNote, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import type { NotePostSaveInput } from '../../src/modules/note/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let timeline: Redis;
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const users: Record<string, { id: string; token: string }> = {};
const logs: string[] = [];
const epoch = Date.parse('2023-01-01T00:00:00Z');
const globalKey = () => `featuredGlobalNotesRanking:${Math.floor((Date.now() - epoch) / 259200000)}`;
const userKey = () => `featuredPerUserNotesRanking:${users.bob.id}:${Math.floor((Date.now() - epoch) / 604800000)}`;
const channelKey = (channelId: string) => `featuredInChannelNotesRanking:${channelId}:${Math.floor((Date.now() - epoch) / 259200000)}`;

async function target(options: Partial<MiNote> = {}) {
	const noteId = id();
	await resources.dataSource.getRepository(MiNote).insert({ id: noteId, userId: users.bob.id, text: 'original', visibility: 'public', localOnly: true, ...options });
	return options.id ?? noteId;
}

async function create(input: object, actor = 'alice') {
	const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users[actor].token, localOnly: true, ...input }) });
	expect(response.status, await response.clone().text()).toBe(200);
	const result = await response.json();
	await resources.notePostSave.idle();
	return result.createdNote as { id: string };
}

async function remove(noteId: string, actor = 'bob') {
	const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: users[actor].token, noteId }) });
	expect(response.status, await response.clone().text()).toBe(204);
	await resources.notePostDelete.idle();
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-timeline`, keyPrefix: `${database.config.redis.prefix}-timeline:` };
	resources = await connectResources(database.config, createLogger('featured-test', line => logs.push(line)));
	timeline = new Redis(database.config.redisForTimelines);
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	app = createBackendHttpApp(resources, database.config);
});
beforeEach(async () => {
	await resources.notePostSave.idle();
	for (const name of ['alice', 'bob']) {
		const userId = id();
		users[name] = { id: userId, token: `t${userId.slice(1)}` };
		await resources.dataSource.getRepository(MiUser).insert({ ...users[name], username: `${name}${userId}`, usernameLower: `${name}${userId}` });
		await resources.dataSource.getRepository(MiUserProfile).insert({ userId });
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { rootUserId: users.alice.id });
	await resources.redis.del(globalKey());
	logs.length = 0;
	vi.spyOn(Math, 'random').mockReturnValue(0.1);
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(async () => {
	timeline?.disconnect();
	await resources?.close();
	await database?.close();
});

test.each([false, true])('authenticated HTTP pure/quote (%s) scores retained original in normal Redis only', async quote => {
	const original = await target();
	let saved!: NotePostSaveInput;
	const start = resources.notePostSave.start;
	vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
		start(value);
	});
	const note = await create({ renoteId: original, ...(quote ? { text: 'quote', visibility: 'home' } : {}) });
	expect(saved.renotedNoteId).toBe(original);
	expect(saved.createdSnapshot?.renote).toMatchObject({ id: original, userId: users.bob.id, visibility: 'public', userHost: null, replyId: null });
	for (const [key, seconds] of [[globalKey(), 777600], [userKey(), 1814400]] as const) {
		expect(await resources.redis.zscore(key, original)).toBe('5');
		expect(await resources.redis.zscore(key, note.id)).toBeNull();
		expect(await resources.redis.ttl(key)).toBeGreaterThan(seconds - 10);
		expect(await resources.redis.ttl(key)).toBeLessThanOrEqual(seconds);
		expect(await timeline.exists(key)).toBe(0);
	}
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: original })).renoteCount).toBe(1);
});

test('existing expiry is preserved by NX; existing no-TTL ranking receives its initial TTL', async () => {
	const original = await target();
	await resources.redis.zadd(globalKey(), 2, original);
	await resources.redis.expire(globalKey(), 123);
	await resources.redis.zadd(userKey(), 1, original);
	await create({ renoteId: original });
	expect(await resources.redis.zscore(globalKey(), original)).toBe('7');
	expect(await resources.redis.zscore(userKey(), original)).toBe('6');
	expect(await resources.redis.ttl(globalKey())).toBeGreaterThan(110);
	expect(await resources.redis.ttl(globalKey())).toBeLessThanOrEqual(123);
	expect(await resources.redis.ttl(userKey())).toBeGreaterThan(1814390);
});

test('channel Renote scores only its channel key independently of fanout settings', async () => {
	const channelId = id();
	await resources.dataSource.getRepository(MiChannel).insert({ id: channelId, userId: users.bob.id, name: 'featured' });
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: false });
	const original = await target({ channelId });
	await create({ renoteId: original, channelId });
	expect(await resources.redis.zscore(channelKey(channelId), original)).toBe('5');
	expect(await resources.redis.ttl(channelKey(channelId))).toBeGreaterThan(777590);
	expect(await resources.redis.exists(globalKey(), userKey())).toBe(0);
});

test.each(['self', 'bot', 'reply', 'old'])('%s Renote is committed without featured scores', async kind => {
	const base = kind === 'reply' ? await target() : null;
	const original = await target({ ...(base ? { replyId: base, replyUserId: users.bob.id } : {}), ...(kind === 'old' ? { id: codec.newId(Date.now() - 259200001) } : {}) });
	if (kind === 'bot') {
		await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isBot: true });
	}
	const note = await create({ renoteId: original }, kind === 'self' ? 'bob' : 'alice');
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
	expect(await resources.redis.zscore(globalKey(), original)).toBeNull();
	expect(await resources.redis.zscore(userKey(), original)).toBeNull();
});

test('global WRONGTYPE preserves per-user score, note/count and HTTP200 with safe command diagnostics', async () => {
	const original = await target();
	await resources.redis.set(globalKey(), 'wrongtype');
	const note = await create({ renoteId: original });
	expect(await resources.redis.get(globalKey())).toBe('wrongtype');
	expect(await resources.redis.zscore(userKey(), original)).toBe('5');
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: original })).renoteCount).toBe(1);
	const error = logs.map(line => JSON.parse(line)).find(line => line.event === 'note-post-save.failed');
	expect(error).toMatchObject({ noteId: note.id, error: { code: 'NOTE_POST_SAVE_FAILED', details: { failures: [{ step: 'featured', error: { code: 'NOTE_FEATURED_FAILED', details: { failures: [{ kind: 'global', error: { code: 'NOTE_FEATURED_REDIS_FAILED', details: { failures: [{ command: 'zincrby' }] } } }] } } }] } } });
	expect(logs.join('')).not.toContain(users.alice.token);
	expect(logs.join('')).not.toContain(database.config.database.password);
});

test('DB count rejection does not block already independent ranking work', async () => {
	const original = await target();
	await resources.dataSource.query(`CREATE FUNCTION reject_featured_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."renoteCount" > OLD."renoteCount" THEN RAISE EXCEPTION 'featured count test'; END IF; RETURN NEW; END $$`);
	await resources.dataSource.query('CREATE TRIGGER reject_featured_count BEFORE UPDATE ON note FOR EACH ROW EXECUTE FUNCTION reject_featured_count()');
	try {
		const note = await create({ renoteId: original });
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: original })).renoteCount).toBe(0);
		expect(await resources.redis.zscore(globalKey(), original)).toBe('5');
		expect(await resources.redis.zscore(userKey(), original)).toBe('5');
		expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-save.failed', error: expect.objectContaining({ details: { failures: [expect.objectContaining({ step: 'counts' })] } }) }));
	} finally {
		await resources.dataSource.query('DROP TRIGGER reject_featured_count ON note');
		await resources.dataSource.query('DROP FUNCTION reject_featured_count()');
	}
});

test('deleting Renote/target retains ranking and delayed snapshot can still add after deletion', async () => {
	const original = await target();
	const renote = await create({ renoteId: original });
	await remove(renote.id, 'alice');
	expect(await resources.redis.zscore(globalKey(), original)).toBe('5');
	let saved!: NotePostSaveInput;
	const spy = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	try {
		await create({ renoteId: original });
	} finally {
		spy.mockRestore();
	}
	await remove(original);
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: original })).toBe(false);
	expect(saved.createdSnapshot?.renote?.id).toBe(original);
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	expect(await resources.redis.zscore(globalKey(), original)).toBe('10');
	expect(await resources.redis.zscore(userKey(), original)).toBe('10');
});
