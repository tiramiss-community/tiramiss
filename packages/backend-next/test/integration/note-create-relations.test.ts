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
import { afterPostSave, createNoteContract } from '../helpers/note-contract.js';

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
// 本家も新実装も指定宛先を順序なしの findBy(In) で取得するため、宛先が複数のケースでは保存順が DB の返却順に依存する。
// 本家の実測は入力順だったが保証されないので、宛先とメンションは集合として比べる。
const unorderedRecipients = new Set(['N3-MN-visible-order']);
// 500 の info.e は DB エラーの文言とリクエストごとの UUID を持つ動的な内部情報なので、完全一致の期待値にしない（Role 互換契約と同じ）。
const internalErrors = new Set(['N3-HE-nfkc-expanding']);
// HTTP の 500 は原因を応答に含めないため、ログへ出た例外で原因を確かめる。
const logLines: string[] = [];
const metaSetups = { sensitive: { sensitiveWords: ['needle'] }, prohibited: { prohibitedWords: ['forbidden'] } };

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const tokens: Record<string, string> = {};

// n3/README の正規化: N0 の ID 字段に非正規化列の ID を、日時字段に lastNotedAt を加える。
const idFields = new Set(['id', 'userId', 'noteId', 'replyId', 'renoteId', 'channelId', 'fileIds', 'visibleUserIds', 'mentions', 'threadId', 'replyUserId', 'renoteUserId', 'renoteChannelId']);
const timeFields = new Set(['createdAt', 'expiresAt', 'lastNotedAt']);

const { ids, remember, normalize, resolve, prepare } = createNoteContract({
	idFields, timeFields, origin: () => database.config.url,
	create: (input, actor) => call('create', input, actor),
	settle: () => resources.notePostSave.idle(),
});

function call(endpoint: 'create' | 'show', input: object, actor: string) {
	return app.request(`/api/notes/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: tokens[actor], ...input }) });
}

function sortRecipients(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) {
		const items = value.map(v => sortRecipients(v, key));
		return key === 'visibleUserIds' || key === 'mentions' ? items.sort() : items;
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sortRecipients(v, k)]));
	}
	return value;
}

function withoutInternalErrorInfo(value: unknown) {
	const { body, ...rest } = value as { body: { error: Record<string, unknown> } };
	const { info: _, ...error } = body.error;
	return { ...rest, body: { error } };
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
	resources = await connectResources(database.config, createLogger('note-create-relations-test', line => {
		logLines.push(line);
	}));
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
	await prepare('bobSpecified', { text: 'bob specified', visibility: 'specified', visibleUserIds: [ids.alice] }, 'bob');
	await prepare('bobLocal', { text: 'bob local', localOnly: true }, 'bob');
	await prepare('bobPure', { renoteId: ids.bobPublic }, 'bob');
	await prepare('bobPureSpecified', { renoteId: ids.bobPublic, visibility: 'specified', localOnly: true }, 'bob');
	await prepare('aliceFollowers', { text: 'alice followers', visibility: 'followers' }, 'alice');
	await prepare('aliceSpecified', { text: 'alice specified', visibility: 'specified', visibleUserIds: [ids.bob] }, 'alice');
	await prepare('aliceSpecifiedMention', { text: 'only mentioned @probe_bob', visibility: 'specified', visibleUserIds: [ids.carol] }, 'alice');
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

// 本家 probe と同じ順に送る。
test.each(cases.map(fixture => [fixture.id, fixture] as const))('%s', async (name, fixture) => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [], prohibitedWords: [], ...(fixture.setup ? metaSetups[fixture.setup] : {}) });
	try {
		const before = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
		logLines.length = 0;
		const response = await call('create', resolve(fixture.params) as object, fixture.actor);
		const body = await response.json();
		const note = body.createdNote;
		if (note) {
			remember(name, note.id);
		}
		await resources.notePostSave.idle();
		const after = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
		const delta = { notes: after.notes - before.notes, polls: after.polls - before.polls };

		const persisted = note ? await saved(note.id) : null;
		const result: Record<string, unknown> = { status: response.status, body, wwwAuthenticate: response.headers.get('www-authenticate'), delta, saved: persisted };
		if (fixture.exactExpiresAt) {
			result.exactExpiresAt = { response: note.poll.expiresAt, saved: persisted?.poll?.expiresAt?.toISOString() };
		}
		if (fixture.watch) {
			result.counts = await counters(fixture.watch);
		}
		if (unorderedRecipients.has(name)) {
			expect(sortRecipients(normalize(result))).toEqual(sortRecipients(golden[name]));
		} else if (internalErrors.has(name)) {
			expect(golden[name].body.error.info.e.code).toBe('QueryFailedError');
			// 新実装も同じ原因（varchar の長さ超過 22001）で失敗したことを確かめる。別の例外の 500 では通さない。
			expect(logLines.map(line => JSON.parse(line)).filter(line => line.event === 'note-create.failed').map(line => line.error))
				.toEqual([{ name: 'QueryFailedError', code: '22001' }]);
			expect(withoutInternalErrorInfo(normalize(result))).toEqual(withoutInternalErrorInfo(golden[name]));
		} else {
			expect(normalize(result)).toEqual(golden[name]);
		}

		if (note) {
			const show = await call('show', { noteId: note.id }, fixture.actor);
			expect(await show.json()).toEqual(afterPostSave(note));
		}
	} finally {
		await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [], prohibitedWords: [] });
	}
});

test('every recorded case is compared', () => {
	expect(Object.keys(golden).sort()).toEqual(cases.map(c => c.id).sort());
});
