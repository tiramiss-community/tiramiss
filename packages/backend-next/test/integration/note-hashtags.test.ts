/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiChannel, MiHashtag, MiMeta, MiNote, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createUserHashtags } from '../../src/composition/user-hashtags.js';
import { createUserHashtagWriter } from '../../src/platform/database/user-hashtags.js';
import { createNoteHashtagWriter } from '../../src/platform/database/note-hashtags.js';
import { createHashtagRanking } from '../../src/platform/hashtag-ranking.js';
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
const rankingKey = (now = Date.now()) => `featuredHashtagsRanking:${Math.floor((now - Date.parse('2023-01-01T00:00:00Z')) / 3600000)}`;
const chartKey = (tag: string, time = Date.now()) => {
	const now = new Date(time);
	now.setMinutes(Math.floor(now.getMinutes() / 10) * 10, 0, 0);
	return `hashtagUsers:${tag}:${now.toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
};

async function create(input: object, actor = 'alice') {
	const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users[actor].token, localOnly: true, ...input }) });
	expect(response.status, `${await response.clone().text()} ${logs.join('')}`).toBe(200);
	const result = await response.json();
	await resources.notePostSave.idle();
	return result.createdNote as { id: string };
}

async function remove(noteId: string) {
	const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: users.alice.token, noteId }) });
	expect(response.status, await response.clone().text()).toBe(204);
	await resources.notePostDelete.idle();
}

const row = (name: string) => resources.dataSource.getRepository(MiHashtag).findOneBy({ name });
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-timeline`, keyPrefix: `${database.config.redis.prefix}-timeline:` };
	resources = await connectResources(database.config, createLogger('hashtag-test', line => logs.push(line)));
	timeline = new Redis(database.config.redisForTimelines);
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	app = createBackendHttpApp(resources, database.config);
});
beforeEach(async () => {
	await resources.notePostSave.idle();
	await resources.userHashtags.idle();
	await resources.dataSource.getRepository(MiHashtag).clear();
	// Remove only this test database's namespace on the shared test Redis.
	const prefix = database.config.redis.keyPrefix!;
	const keys = await resources.redis.keys(`${prefix}*`);
	if (keys.length > 0) {
		await resources.redis.del(...keys.map(key => key.slice(prefix.length)));
	}
	for (const name of ['alice', 'bob']) {
		const userId = id();
		users[name] = { id: userId, token: `t${userId.slice(1)}` };
		await resources.dataSource.getRepository(MiUser).insert({ ...users[name], username: `${name}${userId}`, usernameLower: `${name}${userId}` });
		await resources.dataSource.getRepository(MiUserProfile).insert({ userId });
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { rootUserId: users.alice.id, hiddenTags: [], sensitiveWords: [] });
	logs.length = 0;
});
afterAll(async () => {
	timeline?.disconnect();
	await resources?.close();
	await database?.close();
});

test.each(['public', 'home', 'followers', 'specified'])('HTTP %s uses saved text/cw/poll tags with exact Redis outputs', async visibility => {
	const note = await create({ text: '#Ｔｅｘｔ #Text', cw: '#Cw', poll: { choices: ['#Poll', 'none'] }, visibility, ...(visibility === 'specified' ? { visibleUserIds: [users.bob.id] } : {}) });
	const saved = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: note.id });
	expect(saved.tags).toEqual(['text', 'text', 'cw', 'poll']);
	for (const tag of ['text', 'cw', 'poll']) {
		if (visibility === 'public' || visibility === 'home') {
			expect(await row(tag)).toMatchObject({ mentionedUserIds: [users.alice.id], mentionedUsersCount: 1, mentionedLocalUserIds: [users.alice.id], mentionedLocalUsersCount: 1, mentionedRemoteUserIds: [], attachedUserIds: [], attachedUsersCount: 0 });
			expect(await resources.redis.smembers(`hashtagUsers:${tag}`)).toEqual([users.alice.id]);
			expect(await resources.redis.pfcount(chartKey(tag))).toBe(1);
			expect(Number(await resources.redis.zscore(rankingKey(), tag))).toBeGreaterThanOrEqual(1);
			for (const [key, ttl] of [[`hashtagUsers:${tag}`, 3600], [chartKey(tag), 259200], [rankingKey(), 10800]] as const) {
				expect(await resources.redis.ttl(key)).toBeGreaterThan(ttl - 15);
				expect(await resources.redis.ttl(key)).toBeLessThanOrEqual(ttl);
				expect(await timeline.exists(key)).toBe(0);
			}
		} else {
			expect(await row(tag)).toBeNull();
			expect(await resources.redis.exists(`hashtagUsers:${tag}`)).toBe(0);
		}
	}
});
test('noExtractMentions does not disable tags, while explicit noExtractHashtags skips them', async () => {
	await create({ text: '#Extract', noExtractMentions: true });
	expect(await row('extract')).not.toBeNull();
	await create({ text: '#Skipped', noExtractHashtags: true });
	expect(await row('skipped')).toBeNull();
});
test('bot and channel localOnly notes retain hashtag work', async () => {
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isBot: true });
	const channelId = id();
	await resources.dataSource.getRepository(MiChannel).insert({ id: channelId, userId: users.alice.id, name: 'hashtags' });
	await create({ text: '#Channel', channelId, visibility: 'public', localOnly: true });
	expect(await row('channel')).toMatchObject({ mentionedUserIds: [users.alice.id] });
	expect(await resources.redis.zscore(rankingKey(), 'channel')).toBe('1');
});
test('hidden and sensitive settings suppress only Redis, including after a settings change', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { hiddenTags: ['ＨＩＤＤＥＮ'], sensitiveWords: ['bad word', '/secret/i'] });
	await create({ text: '#hidden #badword #Secret #visible' });
	for (const tag of ['hidden', 'badword', 'secret']) {
		expect(await row(tag)).not.toBeNull();
		expect(await resources.redis.exists(`hashtagUsers:${tag}`)).toBe(0);
	}
	expect(await resources.redis.zscore(rankingKey(), 'visible')).toBe('1');
	await resources.dataSource.getRepository(MiMeta).update('singleton', { hiddenTags: [], sensitiveWords: [] });
	await create({ text: '#hidden' });
	expect(await resources.redis.zscore(rankingKey(), 'hidden')).toBe('1');
});
test('atomic repeated and concurrent local/remote mentions preserve attached fields and distinct arrays', async () => {
	const writer = createNoteHashtagWriter(resources.dataSource.manager, id);
	await resources.dataSource.getRepository(MiHashtag).insert({ id: id(), name: 'atomic', attachedUserIds: ['attached'], attachedUsersCount: 1, attachedLocalUserIds: ['attached'], attachedLocalUsersCount: 1 });
	const authors = Array.from({ length: 12 }, (_, index) => ({ tag: 'atomic', userId: `author${index}`, userHost: index % 2 ? 'remote.example' : null }));
	await Promise.all([...authors, ...authors, ...authors].map(mention => writer.mention(mention)));
	const result = (await row('atomic'))!;
	expect(result.mentionedUserIds.sort()).toEqual(authors.map(a => a.userId).sort());
	expect(result.mentionedUsersCount).toBe(12);
	for (const [host, key, count] of [[null, 'mentionedLocalUserIds', 'mentionedLocalUsersCount'], ['remote.example', 'mentionedRemoteUserIds', 'mentionedRemoteUsersCount']] as const) {
		expect(result[key].sort()).toEqual(authors.filter(a => a.userHost === host).map(a => a.userId).sort());
		expect(result[count]).toBe(6);
	}
	expect(result).toMatchObject({ attachedUserIds: ['attached'], attachedUsersCount: 1, attachedLocalUserIds: ['attached'], attachedLocalUsersCount: 1, attachedRemoteUserIds: [], attachedRemoteUsersCount: 0 });
});
test('unique admission short circuits across chart windows, expiry permits new score, NX never refreshes', async () => {
	let now = Date.parse('2026-11-07T12:34:56Z');
	const update = createHashtagRanking(resources.redis, () => now).update;
	const mention = { tag: 'windows', userId: users.alice.id, userHost: null };
	const settings = { hiddenTags: [], sensitiveWords: [] };
	await update(mention, settings);
	const key = rankingKey(now), chart = chartKey('windows', now), unique = 'hashtagUsers:windows';
	for (const name of [key, chart, unique]) {
		await resources.redis.expire(name, 123);
	}
	await update({ ...mention, userId: users.bob.id }, settings);
	for (const name of [key, chart, unique]) {
		expect(await resources.redis.ttl(name)).toBeLessThanOrEqual(123);
	}
	expect(await resources.redis.pfcount(chart)).toBe(2);
	expect(await resources.redis.zscore(key, 'windows')).toBe('2');
	now += 600000;
	await update(mention, settings);
	expect(await resources.redis.exists(chartKey('windows', now))).toBe(0);
	await resources.redis.expire(unique, 0);
	expect(await resources.redis.exists(unique)).toBe(0);
	await update(mention, settings);
	expect(await resources.redis.zscore(key, 'windows')).toBe('3');
	expect(await resources.redis.pfcount(chartKey('windows', now))).toBe(1);
});
test('forced concurrent same-author membership misses retain source double ranking race', async () => {
	const ordinary = resources.redis.sismember.bind(resources.redis);
	let reads = 0;
	let release!: () => void;
	const barrier = new Promise<void>(resolve => {
		release = resolve;
	});
	const spy = vi.spyOn(resources.redis, 'sismember').mockImplementation((async (...args: Parameters<Redis['sismember']>) => {
		const value = await ordinary(...args);
		if (++reads === 2) {
			release();
		}
		await barrier;
		return value;
	}) as Redis['sismember']);
	try {
		const update = createHashtagRanking(resources.redis, Date.now).update;
		await Promise.all([1, 2].map(() => update({ tag: 'race', userId: users.alice.id, userHost: null }, { hiddenTags: [], sensitiveWords: [] })));
		expect(await resources.redis.zscore(rankingKey(), 'race')).toBe('2');
		expect(await resources.redis.scard('hashtagUsers:race')).toBe(1);
		expect(await resources.redis.pfcount(chartKey('race'))).toBe(1);
	} finally {
		spy.mockRestore();
	}
});
test('SQL trigger rejection stops later tags but started Redis, HTTP save and counts survive', async () => {
	await resources.dataSource.query('CREATE FUNCTION reject_hashtag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = \'reject\' THEN RAISE EXCEPTION \'hashtag test\'; END IF; RETURN NEW; END $$');
	await resources.dataSource.query('CREATE TRIGGER reject_hashtag BEFORE INSERT ON hashtag FOR EACH ROW EXECUTE FUNCTION reject_hashtag()');
	try {
		const note = await create({ text: '#reject #later' });
		expect(await row('reject')).toBeNull();
		expect(await row('later')).toBeNull();
		expect(await resources.redis.zscore(rankingKey(), 'reject')).toBe('1');
		expect(await resources.redis.exists('hashtagUsers:later')).toBe(0);
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.alice.id })).notesCount).toBe(1);
		expect(logs.join('')).toContain('NOTE_HASHTAGS_FAILED');
	} finally {
		await resources.dataSource.query('DROP TRIGGER reject_hashtag ON hashtag');
		await resources.dataSource.query('DROP FUNCTION reject_hashtag()');
	}
});
test.each(['featured', 'chart', 'membership'])('%s WRONGTYPE leaves independent successful commands and DB with diagnostics', async kind => {
	const tag = `wrong${kind}`;
	const key = kind === 'featured' ? rankingKey() : kind === 'chart' ? chartKey(tag) : `hashtagUsers:${tag}`;
	await resources.redis.set(key, 'wrongtype');
	const note = await create({ text: `#${tag} #later` });
	expect(await row(tag)).not.toBeNull();
	expect(await row('later')).not.toBeNull();
	expect(await resources.redis.get(key)).toBe('wrongtype');
	if (kind !== 'membership') {
		expect(await resources.redis.sismember(`hashtagUsers:${tag}`, users.alice.id)).toBe(1);
	}
	if (kind === 'featured') {
		expect(await resources.redis.pfcount(chartKey(tag))).toBe(1);
	}
	if (kind === 'chart') {
		expect(await resources.redis.zscore(rankingKey(), tag)).toBe('1');
	}
	expect(logs.join('')).toContain('NOTE_HASHTAGS_FAILED');
	expect(logs.join('')).toContain(note.id);
	expect(logs.join('')).not.toContain(users.alice.token);
});
test('normalization expansion retains schema rejection at Note INSERT before any post-save work', async () => {
	const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users.alice.token, text: `#${'㍿'.repeat(128)} #later`, localOnly: true }) });
	expect(response.status).toBe(500);
	await resources.notePostSave.idle();
	expect(await resources.dataSource.getRepository(MiHashtag).count()).toBe(0);
	expect(await resources.redis.exists(rankingKey())).toBe(0);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.alice.id })).notesCount).toBe(0);
	expect(logs.join('')).toContain('note-create.failed');
	expect(logs.join('')).not.toContain('note-post-save.failed');
});
test('delete leaves historical aggregates and delayed snapshot writes after note deletion', async () => {
	const note = await create({ text: '#history' });
	await remove(note.id);
	expect(await row('history')).toMatchObject({ mentionedUserIds: [users.alice.id] });
	expect(await resources.redis.zscore(rankingKey(), 'history')).toBe('1');
	let saved!: NotePostSaveInput;
	const spy = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let delayed: { id: string };
	try {
		delayed = await create({ text: '#delayed' });
	} finally {
		spy.mockRestore();
	}
	await remove(delayed!.id);
	expect(await row('delayed')).toBeNull();
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: delayed!.id })).toBe(false);
	expect(await row('delayed')).toMatchObject({ mentionedUserIds: [users.alice.id] });
	expect(await resources.redis.zscore(rankingKey(), 'delayed')).toBe('1');
});

interface SourceRow { id: string; kind: string; input: { user: { id: string; host: string | null }; tags: string[]; initial?: Partial<MiHashtag> }; state: { dbRows: Record<string, Omit<MiHashtag, 'id'>> } }
const oracle: { observations: SourceRow[] } = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/hashtag/source-observations.json', import.meta.url), 'utf8'));
test.each(oracle.observations.filter(value => ['update-local-first', 'update-remote-first', 'update-normalize-collision', 'sql-independent-membership-and-preserved-attached'].includes(value.id)))('real PG equals fixed source complete row: $id', async observation => {
	if (observation.input.initial) {
		await resources.dataSource.getRepository(MiHashtag).insert({ id: id(), ...observation.input.initial });
	}
	const writer = createNoteHashtagWriter(resources.dataSource.manager, id);
	for (const tag of observation.input.tags) {
		await writer.mention({ tag: tag.normalize('NFKC').toLowerCase(), userId: observation.input.user.id, userHost: observation.input.user.host });
	}
	const rows = await resources.dataSource.getRepository(MiHashtag).find();
	expect(Object.fromEntries(rows.map(({ id: _id, ...value }) => [value.name, value]))).toEqual(observation.state.dbRows);
});

test('settings SELECT rejection leaves all DB mentions and independent counts, suppresses only unknown ranking', async () => {
	let saved!: NotePostSaveInput;
	const capture = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let note: { id: string };
	try {
		note = await create({ text: '#settingsfirst #settingssecond' });
	} finally {
		capture.mockRestore();
	}
	const settingsRead = vi.spyOn(resources.dataSource.getRepository(MiMeta), 'find').mockImplementationOnce(async () => {
		await resources.dataSource.query('SELECT * FROM intentionally_missing_hashtag_settings');
		return [];
	});
	try {
		resources.notePostSave.start(saved);
		await resources.notePostSave.idle();
		for (const tag of ['settingsfirst', 'settingssecond']) {
			expect(await row(tag)).toMatchObject({ mentionedUserIds: [users.alice.id], mentionedUsersCount: 1 });
			expect(await resources.redis.exists(`hashtagUsers:${tag}`)).toBe(0);
		}
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note!.id })).toBe(true);
		expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: users.alice.id })).notesCount).toBe(1);
		expect(logs.join('')).toContain('NOTE_HASHTAGS_FAILED');
		expect(logs.join('')).toContain('42P01');
	} finally {
		settingsRead.mockRestore();
	}
});

const profileSource: { id: string; input: { nowMs: number; initial: object | null; user: { id: string; host: string | null; tags: string[] }; tags: string[] }; state: { dbRows: Record<string, object>; sets: Record<string, string[]>; scores: Record<string, Record<string, number>> } }[] = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/hashtag/source-observations.json', import.meta.url), 'utf8')).observations.filter((c: { kind: string }) => c.kind === 'profile');
test.each(profileSource)('$id measures the unchanged five profile oracles with real attached DB and shared Redis ranking', async fixture => {
	// The runtime captures Date.now at construction; supply the oracle's clock explicitly.
	const work = createUserHashtags({
		change: createUserHashtagWriter(resources.dataSource.manager, id).change,
		ranking: createHashtagRanking(resources.redis, () => fixture.input.nowMs),
		readSettings: async () => ({ hiddenTags: [], sensitiveWords: [] }),
	}, createLogger('profile-test', line => logs.push(line)));
	try {
		if (fixture.input.initial) {
			await resources.dataSource.getRepository(MiHashtag).insert({ id: id(), ...fixture.input.initial });
		}
		work.start(fixture.input.user, fixture.input.tags);
		await work.idle();
		const rows = await resources.dataSource.getRepository(MiHashtag).find();
		expect(rows).toHaveLength(Object.keys(fixture.state.dbRows).length);
		for (const [tag, expected] of Object.entries(fixture.state.dbRows)) {
			const actual = rows.find(value => value.name === tag)!;
			const { id: _id, ...projection } = actual;
			expect(projection).toEqual(expected);
		}
		for (const [key, expected] of Object.entries(fixture.state.sets)) {
			expect((await resources.redis.smembers(key)).sort()).toEqual([...expected].sort());
		}
		for (const [key, scores] of Object.entries(fixture.state.scores)) {
			for (const [tag, expected] of Object.entries(scores)) {
				expect(Number(await resources.redis.zscore(key, tag))).toBe(expected);
			}
		}
	} finally {
		await work.close();
	}
});

test('attached atomics preserve independent membership/counts, mentioned columns and empty rows under concurrency', async () => {
	const { createUserHashtagWriter } = await import('../../src/platform/database/user-hashtags.js');
	const writer = createUserHashtagWriter(resources.dataSource.manager, id);
	await resources.dataSource.getRepository(MiHashtag).insert({ id: id(), name: 'atomic', mentionedUserIds: ['mentioned'], mentionedUsersCount: 7, attachedUserIds: ['local'], attachedUsersCount: 8, attachedLocalUserIds: [], attachedLocalUsersCount: 3 });
	const local = { tag: 'atomic', userId: 'local', userHost: null, attached: true };
	const remote = { tag: 'atomic', userId: 'remote', userHost: 'remote.test', attached: true };
	await Promise.all(Array.from({ length: 8 }, () => writer.change(local)));
	await Promise.all(Array.from({ length: 8 }, () => writer.change(remote)));
	expect(await row('atomic')).toMatchObject({ attachedUserIds: ['local', 'remote'], attachedUsersCount: 9, attachedLocalUserIds: ['local'], attachedLocalUsersCount: 4, attachedRemoteUserIds: ['remote'], attachedRemoteUsersCount: 1, mentionedUserIds: ['mentioned'], mentionedUsersCount: 7 });
	await Promise.all(Array.from({ length: 8 }, () => writer.change({ ...local, attached: false })));
	await Promise.all(Array.from({ length: 8 }, () => writer.change({ ...remote, attached: false })));
	expect(await row('atomic')).toMatchObject({ attachedUserIds: [], attachedUsersCount: 7, attachedLocalUserIds: [], attachedLocalUsersCount: 3, attachedRemoteUserIds: [], attachedRemoteUsersCount: 0, mentionedUserIds: ['mentioned'], mentionedUsersCount: 7 });
	await writer.change({ ...local, tag: 'missing-atomic', attached: false });
	expect(await row('missing-atomic')).toBeNull();
});

test('user hidden/sensitive DB changes survive Redis exclusion and note/user ranking share one membership set', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { hiddenTags: ['Ｈｉｄｄｅｎ'], sensitiveWords: ['sensitive'] });
	const actor = { id: users.alice.id, host: null, tags: [] };
	resources.userHashtags.start(actor, ['hidden', 'sensitive', 'shared']);
	await resources.userHashtags.idle();
	for (const tag of ['hidden', 'sensitive']) {
		expect(await row(tag)).toMatchObject({ attachedUserIds: [actor.id], attachedUsersCount: 1 });
		expect(await resources.redis.exists(`hashtagUsers:${tag}`)).toBe(0);
	}
	const before = await resources.redis.zscore(rankingKey(), 'shared');
	await create({ text: '#shared' });
	expect(await resources.redis.zscore(rankingKey(), 'shared')).toBe(before);
	expect(await row('shared')).toMatchObject({ attachedUserIds: [actor.id], mentionedUserIds: [actor.id] });
	resources.userHashtags.start({ ...actor, tags: ['hidden', 'sensitive', 'shared'] }, []);
	await resources.userHashtags.idle();
	for (const tag of ['hidden', 'sensitive', 'shared']) {
		expect(await row(tag)).toMatchObject({ attachedUserIds: [], attachedUsersCount: 0 });
	}
	expect(await resources.redis.zscore(rankingKey(), 'shared')).toBe(before);
});
