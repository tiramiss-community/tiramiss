/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiApp, MiChannel, MiDriveFile, MiMeta, MiNote, MiPoll, MiUser, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createNoteWriteTransactions } from '../../src/platform/database/note-writer.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { afterPostSave } from '../helpers/note-contract.js';
import type { NoteWrites } from '../../src/modules/note/public.js';

const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
const rateGolden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/rate-observations.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/http-cases.json', import.meta.url), 'utf8'));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const actors: Record<string, { id: string; token: string }> = {};
const symbols = new Map<string, string>();
const ids: Record<string, string> = {};

const idFields = new Set(['id', 'userId', 'replyId', 'renoteId', 'channelId', 'fileIds', 'visibleUserIds', 'mentions']);
const timeFields = new Set(['createdAt', 'expiresAt']);

function normalize(value: unknown, key = ''): unknown {
	if (value instanceof Date) {
		return '$time';
	}
	if (Array.isArray(value)) {
		return value.map(v => normalize(v, key));
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
	}
	if (typeof value === 'string') {
		if (idFields.has(key) && symbols.has(value)) {
			return symbols.get(value);
		}
		return timeFields.has(key) ? '$time' : value.replaceAll(database.config.url, '$origin');
	}
	return value;
}

// probe（reference-note.e2e.ts の params）と同じく、未解決の $名で別の入力を送らない。
function resolveParams(value: unknown): unknown {
	if (typeof value === 'string' && value.startsWith('$')) {
		expect(ids[value.slice(1)], `unresolved input ${value}`).toBeDefined();
		return ids[value.slice(1)];
	}
	if (Array.isArray(value)) {
		return value.map(resolveParams);
	}
	if (value !== null && typeof value === 'object') {
		const repeat = (value as { $repeat?: [string, number] }).$repeat;
		if (repeat) {
			return repeat[0].repeat(repeat[1]);
		}
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveParams(v)]));
	}
	return value;
}

function remember(name: string, id: string): string {
	ids[name] = id;
	symbols.set(id, `$${name}`);
	return id;
}

function call(input: unknown, token: string | null = actors.alice.token, authorization?: string) {
	return app.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(input && typeof input === 'object' ? { i: token, ...input } : input) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	database.config.url = 'http://127.0.0.1:61167';
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('note-create-test', () => {}));
	const db = resources.dataSource;
	for (const [i, name] of ['alice', 'limited', 'suspended', 'moved', 'bob'].entries()) {
		const id = remember(name, codec.newId(Date.now() - 100000));
		actors[name] = { id, token: `native${String(i).padStart(10, '0')}` };
		await db.getRepository(MiUser).insert({ id, username: `probe_${name}`, usernameLower: `probe_${name}`, token: actors[name].token, isSuspended: name === 'suspended', movedToUri: name === 'moved' ? 'https://other.test/moved' : null });
	}
	await db.getRepository(MiMeta).insert({ id: 'singleton' });
	const roleId = codec.newId(Date.now());
	await db.getRepository(MiRole).insert({ id: roleId, name: 'limited', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
	await db.query('UPDATE role SET policies=$1 WHERE id=$2', [{ canPublicNote: { useDefault: false, priority: 1, value: false } }, roleId]);
	await db.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), userId: actors.limited.id, roleId });
	for (const [name, permissions, appPermissions] of [
		['noScope', [], null], ['writeScope', ['write:notes'], null], ['appDenied', ['write:notes'], []], ['appWrite', [], ['write:notes']],
	] as const) {
		const appId = appPermissions ? codec.newId(Date.now()) : null;
		if (appId) {
			await db.getRepository(MiApp).insert({ id: appId, name, description: '', secret: 'note-test-only', permission: [...appPermissions!] });
		}
		actors[name] = { id: actors.alice.id, token: `note-access-${name}` };
		await db.getRepository(MiAccessToken).insert({ id: codec.newId(Date.now()), userId: actors.alice.id, appId, token: actors[name].token, hash: `hash-${name}`.toLowerCase(), permission: [...permissions] });
		if (appId) {
			actors[name].token = `HASH-${name.toUpperCase()}`;
		}
	}
	actors.invalid = { id: '', token: 'invalid-token' };
	// probe と同じ値の DriveFile。実アップロードは #188 なので DB へ直接入れる。
	for (const [name, owner] of [['aliceFile1', 'alice'], ['aliceFile2', 'alice'], ['bobFile', 'bob']]) {
		await db.getRepository(MiDriveFile).insert({ id: remember(name, codec.newId(Date.now())), userId: ids[owner], md5: '0'.repeat(32), name: `${name}.png`, type: 'image/png', size: 1, storedInternal: false, url: `http://127.0.0.1:63167/files/${name}.png`, properties: {} });
	}
	remember('missing', '000000000000000000000000');
	app = createBackendHttpApp(resources, database.config);

	// probe（reference-note.e2e.ts の beforeAll）と同じ準備。
	for (const [name, archived] of [['channel', false], ['archived', true]] as const) {
		await db.getRepository(MiChannel).insert({ id: remember(name, codec.newId(Date.now())), name, userId: actors.alice.id, isArchived: archived, allowRenoteToExternal: false });
	}
	await prepare('base', { text: 'base' }, 'bob');
	await prepare('pure', { renoteId: ids.base }, 'bob');
	// 指定宛先の解決は後続の段階なので、本家が保存する列（宛先は mentions にも入る）を直接入れる。
	await db.getRepository(MiNote).insert({ id: remember('private', codec.newId(Date.now())), userId: actors.bob.id, userHost: null, text: 'private', visibility: 'specified', visibleUserIds: [actors.bob.id], mentions: [actors.bob.id] });
	await prepare('channelNote', { text: 'channel', channelId: ids.channel }, 'bob');
});

async function prepare(name: string, input: object, actor: string) {
	const response = await call(input, actors[actor].token);
	expect(response.status).toBe(200);
	remember(name, (await response.json()).createdNote.id);
	await resources.notePostSave.idle();
}

afterAll(async () => {
	await resources?.close();
	await database?.close();
});

async function savedPoll(noteId: string) {
	const poll = await resources.dataSource.getRepository(MiPoll).findOneBy({ noteId });
	return poll ? { choices: poll.choices, multiple: poll.multiple, expiresAt: poll.expiresAt, votes: poll.votes } : null;
}

const pinned = [
	'C1-basic', 'C2-guest', 'C2-invalid', 'C2-suspended', 'C2-moved', 'C2-no-scope', 'C2-app-denied', 'C2-native', 'C2-scoped', 'C2-app-permission',
	'C3-missing', 'C3-whitespace', 'C3-long', 'C3-empty-cw', 'C3-cw-only', 'C4-sensitive', 'C4-policy',
	'C3-missing-file', 'C3-foreign-file', 'C3-file-precedence', 'C3-empty-file-precedence', 'C3-media-alias',
	'C7-default', 'C7-expired', 'C7-relative-priority', 'C7-duplicate', 'C7-one',
	'C6-missing-reply', 'C6-missing-renote', 'C6-reply', 'C6-pure-renote', 'C6-quote', 'C6-reply-pure', 'C6-renote-pure', 'C6-invisible-reply', 'C6-invisible-renote',
	'C8-channel', 'C8-archived', 'C8-external-renote', 'C8-no-extract',
];
test.each(pinned)('%s matches fixed upstream HTTP, saved Note and immediate show', async name => {
	const fixture = cases.find((c: { id: string }) => c.id === name);
	const params = resolveParams(fixture.params);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { sensitiveWords: fixture.setup === 'sensitive' ? ['needle'] : [] });
	const before = await resources.dataSource.getRepository(MiNote).count();
	const polls = await resources.dataSource.getRepository(MiPoll).count();
	const startedAt = Date.now();
	const response = await call(params, fixture.actor ? actors[fixture.actor].token : null);
	const finishedAt = Date.now();
	const body = await response.json();
	if (body.createdNote) {
		remember(name, body.createdNote.id);
	}
	// 次のケースの応答の入れ子が、本家の probe と同じく前のケースの加算後の値になるよう待つ。
	await resources.notePostSave.idle();
	const poll = body.createdNote ? await savedPoll(body.createdNote.id) : null;
	if (name === 'C7-relative-priority') {
		const expiresAt = new Date(body.createdNote.poll.expiresAt).getTime();
		expect(expiresAt).toBeGreaterThanOrEqual(startedAt + 600000);
		expect(expiresAt).toBeLessThanOrEqual(finishedAt + 600000);
		expect(poll?.expiresAt?.getTime()).toBe(expiresAt);
	}
	expect({ status: response.status, body: normalize(body), wwwAuthenticate: response.headers.get('www-authenticate') }).toEqual({ status: golden[name].status, body: golden[name].body, wwwAuthenticate: golden[name].wwwAuthenticate });
	expect({
		notes: await resources.dataSource.getRepository(MiNote).count() - before,
		polls: await resources.dataSource.getRepository(MiPoll).count() - polls,
	}).toEqual(golden[name].delta);
	if (body.createdNote) {
		const row = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: body.createdNote.id });
		const saved = Object.fromEntries(Object.keys(golden[name].saved).map(key => [key, key === 'poll' ? poll : row[key as keyof MiNote]]));
		expect(normalize(saved)).toEqual(golden[name].saved);
		const show = await app.request('/api/notes/show', { method: 'POST', body: JSON.stringify({ noteId: row.id, i: actors.alice.token }) });
		expect(await show.json()).toEqual(afterPostSave(body.createdNote));
	}
});

// probe の C5 で作る2件目の返信（show-reply）を加えた後の、返信先の count。
test('C6-counts: replies and Renotes by others are counted after saving, a self Renote is not', async () => {
	await prepare('show-reply', { text: 'reply', visibility: 'followers', replyId: ids.base }, 'alice');
	const base = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: ids.base });
	expect({ repliesCount: base.repliesCount, renoteCount: base.renoteCount }).toEqual(golden['C6-counts']);
});

// 削除 API は未接続なので、削除前（before）の値だけを照合する。
test('C8-channel-counts before deletion: notesCount counts every post and usersCount each first poster', async () => {
	await prepare('channel-first', { text: 'one', channelId: ids.channel }, 'alice');
	const channel = await resources.dataSource.getRepository(MiChannel).findOneByOrFail({ id: ids.channel });
	expect({ notes: channel.notesCount, users: channel.usersCount }).toEqual(golden['C8-channel-counts'].before);
	// 本家は後続処理の実行時刻を書くため、n3/README の収束規則どおり作成時刻以上であることだけを見る。
	expect(channel.lastNotedAt?.getTime()).toBeGreaterThanOrEqual(codec.createdAtFromId(ids['channel-first']));
});

test('Bearer precedence, non-string credentials and browser headers', async () => {
	expect((await call({ text: 'must not save' }, actors.alice.token, 'Bearer invalid-token')).status).toBe(401);
	for (const i of [false, {}, []]) {
		const response = await call({ text: 'must not save', i });
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('');
	}
	const response = await call({ text: 'headers' });
	expect(response.headers.get('access-control-allow-origin')).toBe('*');
	expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
	const options = await app.request('/api/notes/create', { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
	expect(options.status).toBe(204);
});

test('concurrent creates increment the author count once each after saving', async () => {
	await vi.waitFor(async () => {
		const user = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
		expect(user.notesCount).toBe(await resources.dataSource.getRepository(MiNote).countBy({ userId: user.id }));
	});
	const before = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
	const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => call({ text: `parallel ${i}` })));
	expect(responses.map(r => r.status)).toEqual(Array(12).fill(200));
	await vi.waitFor(async () => {
		const user = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
		expect(user.notesCount).toBe(before.notesCount + 12);
		expect(user.updatedAt).toBeInstanceOf(Date);
	});
});

test.each([{ visibleUserIds: ['missing'], visibility: 'specified' }, { text: '@probe_alice' }, { text: '#tag' }, { cw: ':blob:' }, { poll: { choices: ['@probe_alice', 'b'] } }])('unsupported input %j is refused without saving a partial post', async params => {
	const before = await resources.dataSource.getRepository(MiNote).count();
	const polls = await resources.dataSource.getRepository(MiPoll).count();
	const response = await call({ text: 'do not discard input', ...params });
	expect(response.status).toBe(501);
	expect(await response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
	expect(await resources.dataSource.getRepository(MiNote).count()).toBe(before);
	expect(await resources.dataSource.getRepository(MiPoll).count()).toBe(polls);
});

// 本家 NoteCreateService.ts:673 と 710-720。observations の saved は attachedFileTypes と Poll の非正規化列を持たない。
test('attachments store MIME types and polls copy the corrected Note visibility and author host', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { sensitiveWords: ['needle'] });
	try {
		const response = await call({ text: '  needle  ', fileIds: [ids.aliceFile2, ids.aliceFile1], poll: { choices: ['a', 'b'], multiple: true } });
		expect(response.status).toBe(200);
		const { createdNote } = await response.json();
		const note = await db.getRepository(MiNote).findOneByOrFail({ id: createdNote.id });
		expect({ text: note.text, visibility: note.visibility, hasPoll: note.hasPoll, userHost: note.userHost, fileIds: note.fileIds, attachedFileTypes: note.attachedFileTypes })
			.toEqual({ text: 'needle', visibility: 'home', hasPoll: true, userHost: null, fileIds: [ids.aliceFile2, ids.aliceFile1], attachedFileTypes: ['image/png', 'image/png'] });
		const poll = await db.getRepository(MiPoll).findOneByOrFail({ noteId: note.id });
		expect({ noteVisibility: poll.noteVisibility, userId: poll.userId, userHost: poll.userHost, channelId: poll.channelId, multiple: poll.multiple, votes: poll.votes })
			.toEqual({ noteVisibility: 'home', userId: actors.alice.id, userHost: null, channelId: null, multiple: true, votes: [0, 0] });
		expect(createdNote.poll).toEqual({ multiple: true, expiresAt: null, choices: [{ text: 'a', votes: 0, isVoted: false }, { text: 'b', votes: 0, isVoted: false }] });
	} finally {
		await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [] });
	}
});

// 本家 NoteCreateService.ts:573-582: 添付・投票があれば空白だけの text はスキーマを通り、null で保存される。
test('whitespace-only text with a poll is stored as null', async () => {
	const response = await call({ text: ' \n ', poll: { choices: ['a', 'b'] } });
	expect(response.status).toBe(200);
	const { createdNote } = await response.json();
	expect(createdNote.text).toBeNull();
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: createdNote.id })).text).toBeNull();
});

// 本家 NoteCreateService.ts:300-420 の後に 481-489。存在しないファイルは期限切れの投票と禁止語より先に返す。
test('related checks precede expiry and prohibited words without saving anything', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { prohibitedWords: ['forbidden'] });
	try {
		const notes = await db.getRepository(MiNote).count();
		const polls = await db.getRepository(MiPoll).count();
		const expired = { choices: ['forbidden', 'b'], expiresAt: 1 };
		const codes = [];
		for (const input of [
			{ text: 'x', fileIds: [ids.missing], poll: expired },
			{ text: 'x', fileIds: [ids.aliceFile1], poll: expired },
			{ text: 'x', fileIds: [ids.aliceFile1], poll: { choices: ['forbidden', 'b'] } },
		]) {
			codes.push((await (await call(input)).json()).error.code);
		}
		expect(codes).toEqual(['NO_SUCH_FILE', 'CANNOT_CREATE_ALREADY_EXPIRED_POLL', 'CONTAINS_PROHIBITED_WORDS']);
		expect(await db.getRepository(MiNote).count()).toBe(notes);
		expect(await db.getRepository(MiPoll).count()).toBe(polls);
	} finally {
		await db.getRepository(MiMeta).update('singleton', { prohibitedWords: [] });
	}
});

// 本家 NoteCreateService.ts:704-726: Note と Poll は 1 つの transaction で保存される。
test('a failing Poll insert leaves neither Note nor Poll and starts no post-save count', async () => {
	const db = resources.dataSource;
	await vi.waitFor(async () => {
		const user = await db.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
		expect(user.notesCount).toBe(await db.getRepository(MiNote).countBy({ userId: user.id }));
	});
	const before = await db.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
	const notes = await db.getRepository(MiNote).count();
	const polls = await db.getRepository(MiPoll).count();
	await db.query('CREATE FUNCTION public.reject_test_poll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.choices[1] = \'fail-poll-170\' THEN RAISE EXCEPTION \'injected Poll insert failure\'; END IF; RETURN NEW; END $$');
	await db.query('CREATE TRIGGER reject_test_poll BEFORE INSERT ON poll FOR EACH ROW EXECUTE FUNCTION public.reject_test_poll()');
	try {
		const response = await call({ text: 'poll rollback', poll: { choices: ['fail-poll-170', 'b'] } });
		expect(response.status).toBe(500);
		expect(await db.getRepository(MiNote).count()).toBe(notes);
		expect(await db.getRepository(MiPoll).count()).toBe(polls);
		await new Promise(resolve => setTimeout(resolve, 50));
		expect((await db.getRepository(MiUser).findOneByOrFail({ id: before.id })).notesCount).toBe(before.notesCount);
	} finally {
		await db.query('DROP TRIGGER reject_test_poll ON poll');
		await db.query('DROP FUNCTION public.reject_test_poll()');
	}
});

// transaction の外へ持ち出した書き込み口で、commit 後に別の自動 commit として保存させない。
test('rejects note writes after their transaction has ended', async () => {
	const db = resources.dataSource;
	const notes = await db.getRepository(MiNote).count();
	const polls = await db.getRepository(MiPoll).count();
	let ended!: NoteWrites;
	await createNoteWriteTransactions(db).run(async writes => {
		ended = writes;
	});
	const noteId = codec.newId(Date.now());
	await expect(ended.insertNote({
		id: noteId, userId: actors.alice.id, userHost: null, text: 'ended', cw: null, visibility: 'public', localOnly: false, reactionAcceptance: null, channelId: null,
		fileIds: [], attachedFileTypes: [], hasPoll: true, replyId: null, renoteId: null, threadId: null, replyUserId: null, replyUserHost: null,
		renoteUserId: null, renoteUserHost: null, renoteChannelId: null, visibleUserIds: [], mentions: [], mentionedRemoteUsers: [],
	})).rejects.toThrow('ended');
	await expect(ended.insertPoll({ noteId, choices: ['a', 'b'], multiple: false, expiresAtMs: null, votes: [0, 0], noteVisibility: 'public', userId: actors.alice.id, userHost: null, channelId: null })).rejects.toThrow('ended');
	expect(await db.getRepository(MiNote).count()).toBe(notes);
	expect(await db.getRepository(MiPoll).count()).toBe(polls);
});

test('explicit no-extract preserves literal text and public/basic flags are saved', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { sensitiveWords: [] });
	const response = await call({ text: '  @probe_alice #tag :blob:  ', noExtractMentions: true, noExtractHashtags: true, noExtractEmojis: true, cw: 'cw', localOnly: true, visibility: 'followers', reactionAcceptance: 'likeOnly' });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ createdNote: { text: '@probe_alice #tag :blob:', cw: 'cw', localOnly: true, visibility: 'followers', reactionAcceptance: 'likeOnly' } });
});

test('production rate limit consumes invalid input first and precedes suspended/moved/scope checks', async () => {
	const db = resources.dataSource;
	const roleId = codec.newId(Date.now());
	const userId = codec.newId(Date.now() - 10000);
	const token = 'rate169000000000';
	await db.getRepository(MiUser).insert({ id: userId, username: 'rate169', usernameLower: 'rate169', token });
	await db.getRepository(MiRole).insert({ id: roleId, name: 'rate', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
	await db.query('UPDATE role SET policies=$1 WHERE id=$2', [{ rateLimitFactor: { useDefault: false, priority: 1, value: 300 } }, roleId]);
	await db.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), roleId, userId });
	resources.roleMaterials.changes.invalidateLocal({ kind: 'role-definitions-changed', roleId });
	vi.stubEnv('NODE_ENV', 'production');
	try {
		const production = createBackendHttpApp(resources, database.config);
		const request = (i: string) => production.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i }) });
		const first = await request(token);
		expect({ status: first.status, body: await first.json(), wwwAuthenticate: first.headers.get('www-authenticate') }).toEqual(rateGolden['C2-rate-first-invalid']);
		await db.getRepository(MiUser).update(userId, { isSuspended: true, movedToUri: 'https://moved.test/' });
		const second = await request(token);
		expect(second.status).toBe(429);
		const body = await second.json();
		expect(body).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED', info: { total: 1, remaining: 0 } } });
		expect(body.error.info.resetMs).toBeGreaterThan(Date.now());
		expect(body.error.info.reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
		expect({ status: second.status, body: { error: { ...body.error, info: { ...body.error.info, reset: '$future-epoch-seconds', resetMs: '$future-epoch-milliseconds' } } }, wwwAuthenticate: second.headers.get('www-authenticate') }).toEqual(rateGolden['C2-rate-before-input']);
		expect(await db.getRepository(MiNote).countBy({ userId })).toBe(0);
	} finally {
		vi.unstubAllEnvs();
	}
});

test('insert failure returns 500 without Note, post-save count or automatic retry', async () => {
	const db = resources.dataSource;
	const before = await db.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
	const notes = await db.getRepository(MiNote).count();
	await db.query('CREATE FUNCTION public.reject_test_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.text = \'fail-insert-169\' THEN RAISE EXCEPTION \'injected Note insert failure\'; END IF; RETURN NEW; END $$');
	await db.query('CREATE TRIGGER reject_test_note BEFORE INSERT ON note FOR EACH ROW EXECUTE FUNCTION public.reject_test_note()');
	try {
		const response = await call({ text: 'fail-insert-169' });
		expect(response.status).toBe(500);
		expect(await db.getRepository(MiNote).count()).toBe(notes);
		expect((await db.getRepository(MiUser).findOneByOrFail({ id: before.id })).notesCount).toBe(before.notesCount);
	} finally {
		await db.query('DROP TRIGGER reject_test_note ON note');
		await db.query('DROP FUNCTION public.reject_test_note()');
	}
});

test('word controls, CW precedence, and Unicode length boundaries reach stored Note', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { sensitiveWords: ['needle'], prohibitedWords: ['blocked combo', '/forbidden/i'] });
	try {
		const suppressed = await call({ text: 'needle' });
		expect(await suppressed.json()).toMatchObject({ createdNote: { visibility: 'home' } });
		const cwWins = await call({ text: 'needle', cw: 'safe' });
		expect(await cwWins.json()).toMatchObject({ createdNote: { visibility: 'public' } });
		const before = await db.getRepository(MiNote).count();
		for (const input of [{ text: 'combo', cw: 'blocked ' }, { text: 'Forbidden' }]) {
			const response = await call(input);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 'CONTAINS_PROHIBITED_WORDS' } });
		}
		expect(await db.getRepository(MiNote).count()).toBe(before);
		const max = await call({ text: '😀'.repeat(3000), cw: 'c'.repeat(100) });
		expect(max.status).toBe(200);
		expect(await max.json()).toMatchObject({ createdNote: { text: '😀'.repeat(3000), cw: 'c'.repeat(100) } });
		expect((await call({ text: '😀'.repeat(3001) })).status).toBe(400);
		expect((await call({ text: 'hello', cw: 'c'.repeat(101) })).status).toBe(400);
	} finally {
		await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [], prohibitedWords: [] });
	}
});
