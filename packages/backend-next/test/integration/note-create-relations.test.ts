/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiBlocking, MiChannel, MiDriveFile, MiFollowing, MiMeta, MiNote, MiPoll, MiRole, MiRoleAssignment, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { afterPostSave } from '../helpers/note-contract.js';

interface Fixture {
	id: string;
	actor: string;
	params: Record<string, unknown>;
	setup?: 'sensitive' | 'prohibited';
	watch?: { notes?: string[]; channels?: string[] };
	exactExpiresAt?: boolean;
}

const n3 = '../../../../docs/superpowers/compatibility/note/n3/';
const golden = JSON.parse(readFileSync(new URL(`${n3}observations.json`, import.meta.url), 'utf8'));
const cases: Fixture[] = JSON.parse(readFileSync(new URL(`${n3}http-cases.json`, import.meta.url), 'utf8'));
// 指定宛先の解決と MFM 抽出（メンション・ハッシュタグ・絵文字）が要るケースは、それらを実装する段階で接続する。
const deferred = new Set(cases.map(c => c.id).filter(id =>
	id === 'N3-FP-poll-specified' || id === 'N3-RR-reply-specified' ||
	(/^N3-(MN|HE)-/.test(id) && !['N3-MN-specified-empty', 'N3-MN-visible-duplicate', 'N3-MN-noextract-reply'].includes(id))));
// 後続の段階のケースは保存されないため、本家で後のケースから見える副作用だけを DB に再現し、実測値は書き換えずに比べる。
const deferredEffects: Record<string, () => Promise<unknown>> = {
	// 本家はこの返信を保存して bobPublic の repliesCount を加算し、N3-MN-noextract-reply の入れ子の値に現れる。
	'N3-MN-limit-reply-boundary': () => resources.dataSource.getRepository(MiNote).increment({ id: ids.bobPublic }, 'repliesCount', 1),
};
const metaSetups = { sensitive: { sensitiveWords: ['needle'] }, prohibited: { prohibitedWords: ['forbidden'] } };

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const tokens: Record<string, string> = {};
const symbols = new Map<string, string>();
const ids: Record<string, string> = {};

// n3/README の正規化: N0 の ID 字段に非正規化列の ID を、日時字段に lastNotedAt を加える。
const idFields = new Set(['id', 'userId', 'noteId', 'replyId', 'renoteId', 'channelId', 'fileIds', 'visibleUserIds', 'mentions', 'threadId', 'replyUserId', 'renoteUserId', 'renoteChannelId']);
const timeFields = new Set(['createdAt', 'expiresAt', 'lastNotedAt']);

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

function resolve(value: unknown): unknown {
	if (typeof value === 'string' && value.startsWith('$')) {
		expect(ids[value.slice(1)], `unresolved input ${value}`).toBeDefined();
		return ids[value.slice(1)];
	}
	if (Array.isArray(value)) {
		return value.map(resolve);
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
	}
	return value;
}

function remember(name: string, id: string): string {
	ids[name] = id;
	symbols.set(id, `$${name}`);
	return id;
}

function call(endpoint: 'create' | 'show', input: object, actor: string) {
	return app.request(`/api/notes/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: tokens[actor], ...input }) });
}

// probe は保存後の count が収束するまで次の入力を送らないため、同じく保存後処理の完了を待つ。
async function prepare(name: string, input: object, actor: string) {
	const response = await call('create', input, actor);
	expect(response.status, name).toBe(200);
	remember(name, (await response.json()).createdNote.id);
	await resources.notePostSave.idle();
}

// 指定宛先の解決は後続の段階なので、本家が保存する列を直接入れる。本家は指定宛先を mentions にも入れる。
async function insertSpecified(name: string, actor: string, text: string, visibleUserIds: string[], mentions: string[]) {
	await resources.dataSource.getRepository(MiNote).insert({ id: remember(name, codec.newId(Date.now())), userId: ids[actor], userHost: null, text, visibility: 'specified', visibleUserIds, mentions });
}

async function saved(noteId: string) {
	const note = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: noteId });
	const poll = await resources.dataSource.getRepository(MiPoll).findOneBy({ noteId });
	const { id, text, cw, visibility, localOnly, reactionAcceptance, fileIds, replyId, renoteId, channelId, visibleUserIds, mentions, tags, emojis, hasPoll, threadId, replyUserId, replyUserHost, renoteUserId, renoteUserHost, renoteChannelId, attachedFileTypes, mentionedRemoteUsers } = note;
	return {
		id, text, cw, visibility, localOnly, reactionAcceptance, fileIds, replyId, renoteId, channelId, visibleUserIds, mentions, tags, emojis, hasPoll,
		threadId, replyUserId, replyUserHost, renoteUserId, renoteUserHost, renoteChannelId, attachedFileTypes, mentionedRemoteUsers,
		poll: poll ? { choices: poll.choices, multiple: poll.multiple, expiresAt: poll.expiresAt, votes: poll.votes, noteVisibility: poll.noteVisibility, userId: poll.userId, userHost: poll.userHost, channelId: poll.channelId } : null,
	};
}

async function counters(watch: NonNullable<Fixture['watch']>) {
	const db = resources.dataSource;
	const notes: Record<string, unknown> = {};
	for (const name of watch.notes ?? []) {
		const note = await db.getRepository(MiNote).findOneByOrFail({ id: resolve(name) as string });
		notes[name] = { repliesCount: note.repliesCount, renoteCount: note.renoteCount };
	}
	const channels: Record<string, unknown> = {};
	for (const name of watch.channels ?? []) {
		const channel = await db.getRepository(MiChannel).findOneByOrFail({ id: resolve(name) as string });
		channels[name] = { notesCount: channel.notesCount, usersCount: channel.usersCount, lastNotedAt: channel.lastNotedAt };
	}
	return { notes, channels };
}

beforeAll(async () => {
	database = await createTestDatabase();
	database.config.url = 'http://127.0.0.1:61167';
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('note-create-relations-test', () => {}));
	const db = resources.dataSource;
	await db.getRepository(MiMeta).insert({ id: 'singleton' });

	// n3/README の初期データ。signup の代わりに DB へ入れる。
	for (const [i, name] of ['root', 'alice', 'bob', 'carol', 'botter', 'blocker', 'blockee', 'suspended', 'limiter'].entries()) {
		const id = remember(name, codec.newId(Date.now() - 100000));
		tokens[name] = `relation${String(i).padStart(8, '0')}`;
		await db.getRepository(MiUser).insert({ id, username: `probe_${name}`, usernameLower: `probe_${name}`, token: tokens[name], isSuspended: name === 'suspended', isBot: name === 'botter' });
	}
	const roleId = codec.newId(Date.now());
	await db.getRepository(MiRole).insert({ id: roleId, name: 'mention-limit', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
	await db.query('UPDATE role SET policies=$1 WHERE id=$2', [{ mentionLimit: { useDefault: false, priority: 1, value: 2 } }, roleId]);
	await db.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), userId: ids.limiter, roleId });
	for (const [name, type] of [['aliceImage', 'image/png'], ['aliceVideo', 'video/mp4']]) {
		await db.getRepository(MiDriveFile).insert({ id: remember(name, codec.newId(Date.now())), userId: ids.alice, md5: '0'.repeat(32), name: `${name}.bin`, type, size: 1, storedInternal: false, url: `http://127.0.0.1:63167/files/${name}`, properties: {} });
	}
	for (const [name, url] of [['rwithurl', 'https://remote.example/@rwithurl'], ['rnourl', null]] as const) {
		const id = remember(name, codec.newId(Date.now()));
		const host = 'remote.example';
		await db.getRepository(MiUser).insert({ id, username: name, usernameLower: name, host, uri: `https://${host}/users/${name}`, inbox: `https://${host}/users/${name}/inbox`, sharedInbox: `https://${host}/inbox`, lastFetchedAt: new Date() });
		await db.getRepository(MiUserProfile).insert({ userId: id, userHost: host, url });
	}
	await db.getRepository(MiNote).insert({ id: remember('remoteNote', codec.newId(Date.now())), userId: ids.rwithurl, userHost: 'remote.example', text: 'remote', visibility: 'public', uri: 'https://remote.example/notes/1' });
	await db.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: ids.alice, followeeId: ids.bob });
	remember('missing', '000000000000000000000000');
	for (const [name, allow] of [['chClosed', false], ['chOpen', true], ['chArchived', true], ['chCount', true]] as const) {
		await db.getRepository(MiChannel).insert({ id: remember(name, codec.newId(Date.now())), name, userId: ids.bob, isArchived: false, allowRenoteToExternal: allow });
	}
	for (const [blocker, blockee] of [['blocker', 'alice'], ['alice', 'blockee']]) {
		await db.getRepository(MiBlocking).insert({ id: codec.newId(Date.now()), blockerId: ids[blocker], blockeeId: ids[blockee] });
	}

	app = createBackendHttpApp(resources, database.config);
	await prepare('bobPublic', { text: 'bob public' }, 'bob');
	await prepare('bobOther', { text: 'bob other' }, 'bob');
	await prepare('bobThreadRoot', { text: 'thread root' }, 'bob');
	await prepare('bobWhitespaceTarget', { text: 'whitespace target' }, 'bob');
	await prepare('bobHome', { text: 'bob home', visibility: 'home' }, 'bob');
	await prepare('bobFollowers', { text: 'bob followers', visibility: 'followers' }, 'bob');
	await insertSpecified('bobSpecified', 'bob', 'bob specified', [ids.alice], [ids.alice]);
	await prepare('bobLocal', { text: 'bob local', localOnly: true }, 'bob');
	await prepare('bobPure', { renoteId: ids.bobPublic }, 'bob');
	await prepare('bobPureSpecified', { renoteId: ids.bobPublic, visibility: 'specified', localOnly: true }, 'bob');
	await prepare('aliceFollowers', { text: 'alice followers', visibility: 'followers' }, 'alice');
	await insertSpecified('aliceSpecified', 'alice', 'alice specified', [ids.bob], [ids.bob]);
	// 本文のメンションが先、指定宛先が後の順で mentions に入る。
	await insertSpecified('aliceSpecifiedMention', 'alice', 'only mentioned @probe_bob', [ids.carol], [ids.bob, ids.carol]);
	await prepare('blockerNote', { text: 'blocker' }, 'blocker');
	await prepare('blockeeNote', { text: 'blockee' }, 'blockee');
	await prepare('chClosedNote', { text: 'closed channel', channelId: ids.chClosed }, 'bob');
	await prepare('chOpenNote', { text: 'open channel', channelId: ids.chOpen }, 'bob');
	await prepare('chArchivedNote', { text: 'archived channel', channelId: ids.chArchived }, 'bob');
	await db.getRepository(MiChannel).update(ids.chArchived, { isArchived: true });
	for (const [name, owner] of [['countBotRenote', 'bob'], ['countBotReply', 'bob'], ['countSelfReply', 'alice'], ['countSelfQuote', 'alice'], ['countOtherQuote', 'bob'], ['countOtherPure', 'bob']]) {
		await prepare(name, { text: name }, owner);
	}
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
});

// 本家 probe と同じ順に送る。後続の段階のケースも送って、黙って保存せず 501 で拒否することを確かめる。
test.each(cases.map(fixture => [fixture.id, fixture] as const))('%s', async (name, fixture) => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [], prohibitedWords: [], ...(fixture.setup ? metaSetups[fixture.setup] : {}) });
	try {
		const before = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
		const response = await call('create', resolve(fixture.params) as object, fixture.actor);
		const body = await response.json();
		const note = body.createdNote;
		if (note) {
			remember(name, note.id);
		}
		await resources.notePostSave.idle();
		const after = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
		const delta = { notes: after.notes - before.notes, polls: after.polls - before.polls };
		if (deferred.has(name) && !(response.status === 400 && body.error.code === 'INVALID_PARAM')) {
			expect({ status: response.status, code: body.error?.code, delta }).toEqual({ status: 501, code: 'NOT_IMPLEMENTED', delta: { notes: 0, polls: 0 } });
			await deferredEffects[name]?.();
			return;
		}

		const persisted = note ? await saved(note.id) : null;
		const result: Record<string, unknown> = { status: response.status, body, wwwAuthenticate: response.headers.get('www-authenticate'), delta, saved: persisted };
		if (fixture.exactExpiresAt) {
			result.exactExpiresAt = { response: note.poll.expiresAt, saved: persisted?.poll?.expiresAt?.toISOString() };
		}
		if (fixture.watch) {
			result.counts = await counters(fixture.watch);
		}
		expect(normalize(result)).toEqual(golden[name]);

		if (note) {
			const show = await call('show', { noteId: note.id }, fixture.actor);
			expect(await show.json()).toEqual(afterPostSave(note));
		}
	} finally {
		await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [], prohibitedWords: [] });
	}
});

test('every recorded case is either compared or deferred to a later stage', () => {
	expect(Object.keys(golden).sort()).toEqual(cases.map(c => c.id).sort());
	expect([...deferred].sort()).toEqual([
		'N3-FP-poll-specified', 'N3-HE-case-dup', 'N3-HE-cw-choice', 'N3-HE-emoji-case-dup', 'N3-HE-fullwidth', 'N3-HE-inline-code', 'N3-HE-length',
		'N3-HE-nfkc-expanding', 'N3-HE-only-hashtags-off', 'N3-HE-over-32', 'N3-MN-cw-choice', 'N3-MN-dedupe', 'N3-MN-limit-boundary', 'N3-MN-limit-dedupe',
		'N3-MN-limit-over', 'N3-MN-limit-reply-boundary', 'N3-MN-limit-reply-over', 'N3-MN-limit-self', 'N3-MN-limit-visible-boundary',
		'N3-MN-limit-visible-over', 'N3-MN-missing-local', 'N3-MN-remote', 'N3-MN-remote-visible', 'N3-MN-suspended',
		'N3-MN-visible-missing', 'N3-MN-visible-order', 'N3-RR-reply-specified',
	]);
});
