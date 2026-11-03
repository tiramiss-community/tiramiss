/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 固定本家の作業用コピーの test/e2e へ複製して使う。手順は README.md。
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { api, signup, initTestDb } from '../utils.js';
import { loadConfig } from '@/config.js';
import { genAidx } from '@/misc/id/aidx.js';
import { MiUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiNote } from '@/models/Note.js';
import { MiPoll } from '@/models/Poll.js';
import { MiRole } from '@/models/Role.js';
import { MiRoleAssignment } from '@/models/RoleAssignment.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiChannel } from '@/models/Channel.js';
import { MiFollowing } from '@/models/Following.js';
import { In } from 'typeorm';
import type { DataSource } from 'typeorm';

type Actor = { id: string; token: string };
const config = loadConfig();
if (process.env.NODE_ENV !== 'test' || config.db.host !== '127.0.0.1' || config.db.port !== 55167 || config.db.db !== 'backend_next_test' || config.dbReplications || config.redis.host !== '127.0.0.1' || config.redis.port !== 56167 || config.port !== 61167) {
	throw new Error('Only the dedicated note-167 test configuration is supported.');
}
const inputs = JSON.parse(readFileSync(new URL('./note-n3-http-cases.json', import.meta.url), 'utf8'));
const goldenUrl = new URL('./note-n3-observations.json', import.meta.url);
const recording = process.env.NOTE_PROBE_RECORD === '1';
const expected = recording ? {} : JSON.parse(readFileSync(goldenUrl, 'utf8'));
const observed: Record<string, unknown> = {};
const actors: Record<string, Actor> = {};
const ids: Record<string, string> = {};
const symbols = new Map<string, string>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let suiteFailed = false;
let suiteCompleted = false;
let db: DataSource;
let redis: Redis;
let subscriber: Redis;
const events: any[] = [];

function remember(name: string, id: string): string {
	ids[name] = id;
	symbols.set(id, `$${name}`);
	return id;
}

const idFields = new Set(['id', 'userId', 'noteId', 'replyId', 'renoteId', 'channelId', 'fileIds', 'visibleUserIds', 'mentions', 'threadId', 'replyUserId', 'renoteUserId', 'renoteChannelId']);
const timeFields = new Set(['createdAt', 'expiresAt', 'lastNotedAt']);
const originUrls = new RegExp(`${config.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s"'<>]*`, 'g');

function normalize(value: any, key = ''): any {
	if (value instanceof Date) {
		return '$time';
	}
	if (typeof value === 'string') {
		if (timeFields.has(key) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value)) {
			return '$time';
		}
		if (idFields.has(key) && symbols.has(value)) {
			return symbols.get(value);
		}
		return value.replace(originUrls, url => {
			const path = url.slice(config.url.length + 1).split(/([/#?=&])/).map(part => symbols.get(part) ?? part).join('');
			return `$origin/${path}`;
		});
	}
	if (Array.isArray(value)) {
		return value.map(item => normalize(item, key));
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, normalize(item, field)]));
	}
	return value;
}

function params(value: any): any {
	if (typeof value === 'string' && value.startsWith('$')) {
		expect(ids[value.slice(1)], `unresolved input ${value}`).toBeDefined();
		return ids[value.slice(1)];
	}
	if (Array.isArray(value)) {
		return value.map(params);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, params(item)]));
	}
	return value;
}

function capture(id: string, value: unknown) {
	const normalized = normalize(value);
	expect(observed).not.toHaveProperty(id);
	observed[id] = normalized;
	if (!recording) {
		expect(normalized, id).toEqual(expected[id]);
	}
}

async function settleUser(userId: string) {
	// 本家は保存後の加算を応答前に待たないため、応答直後の値ではなく actor の全Noteが数え終わるまで待つ。
	await vi.waitFor(async () => {
		const user = await db.getRepository(MiUser).findOneByOrFail({ id: userId });
		expect(user.notesCount).toBe(await db.getRepository(MiNote).countBy({ userId }));
	}, { timeout: 10000, interval: 50 });
}

async function stable(read: () => Promise<unknown>) {
	let last = JSON.stringify(await read());
	let same = 0;
	const deadline = Date.now() + 10000;
	while (same < 5) {
		expect(Date.now(), 'counters did not settle').toBeLessThan(deadline);
		await new Promise(resolve => setTimeout(resolve, 100));
		const next = JSON.stringify(await read());
		same = next === last ? same + 1 : 0;
		last = next;
	}
}

type Watch = { notes?: string[]; channels?: string[] };

async function counters(watch: Watch) {
	const notes: Record<string, unknown> = {};
	for (const name of watch.notes ?? []) {
		const note = await db.getRepository(MiNote).findOneByOrFail({ id: params(name) });
		notes[name] = { repliesCount: note.repliesCount, renoteCount: note.renoteCount };
	}
	const channels: Record<string, unknown> = {};
	for (const name of watch.channels ?? []) {
		const channel = await db.getRepository(MiChannel).findOneByOrFail({ id: params(name) });
		channels[name] = { notesCount: channel.notesCount, usersCount: channel.usersCount, lastNotedAt: channel.lastNotedAt };
	}
	return { notes, channels };
}

async function settle(userId: string, note: any, watch: Watch = {}) {
	await settleUser(userId);
	const noteIds = [...(watch.notes ?? []).map(params), note.replyId, note.renoteId].filter(id => id != null);
	const channelIds = [...(watch.channels ?? []).map(params), note.channelId].filter(id => id != null);
	if (note.channelId != null) {
		// channel の更新は postNoteCreated の最後で、notesCount だけでは開始を判別できないため lastNotedAt で確かめる。
		await vi.waitFor(async () => {
			const channel = await db.getRepository(MiChannel).findOneByOrFail({ id: note.channelId });
			expect(channel.lastNotedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(new Date(note.createdAt).getTime());
		}, { timeout: 10000, interval: 50 });
	}
	await stable(async () => [
		noteIds.length ? (await db.getRepository(MiNote).findBy({ id: In(noteIds) })).map(x => [x.id, x.repliesCount, x.renoteCount]).sort() : [],
		channelIds.length ? (await db.getRepository(MiChannel).findBy({ id: In(channelIds) })).map(x => [x.id, x.notesCount, x.usersCount]).sort() : [],
	]);
}

async function call(input: any, actor: string) {
	return api('notes/create' as never, input, actors[actor]);
}

async function create(name: string, input: any, actor: string): Promise<any> {
	const response = await call(input, actor);
	expect(response.status, JSON.stringify(response.body)).toBe(200);
	const note = (response.body as any).createdNote;
	remember(name, note.id);
	await settle(actors[actor].id, note);
	return note;
}

async function saved(noteId: string) {
	const note = await db.getRepository(MiNote).findOneByOrFail({ id: noteId });
	const poll = await db.getRepository(MiPoll).findOneBy({ noteId });
	const { id, text, cw, visibility, localOnly, reactionAcceptance, fileIds, replyId, renoteId, channelId, visibleUserIds, mentions, tags, emojis, hasPoll, threadId, replyUserId, replyUserHost, renoteUserId, renoteUserHost, renoteChannelId, attachedFileTypes, mentionedRemoteUsers } = note;
	return {
		id, text, cw, visibility, localOnly, reactionAcceptance, fileIds, replyId, renoteId, channelId, visibleUserIds, mentions, tags, emojis, hasPoll,
		threadId, replyUserId, replyUserHost, renoteUserId, renoteUserHost, renoteChannelId, attachedFileTypes, mentionedRemoteUsers,
		poll: poll ? { choices: poll.choices, multiple: poll.multiple, expiresAt: poll.expiresAt, votes: poll.votes, noteVisibility: poll.noteVisibility, userId: poll.userId, userHost: poll.userHost, channelId: poll.channelId } : null,
	};
}

async function updateMeta(values: Record<string, string[]>) {
	const start = events.length;
	expect((await api('admin/update-meta', values, actors.root)).status).toBe(204);
	// NoteCreateService の Meta は Redis の内部イベントで書き換わるため、update-meta の応答だけでは反映を保証できない。
	await vi.waitFor(() => expect(events.slice(start).some(event => event.channel === 'internal' && event.message.type === 'metaUpdated' && Object.entries(values).every(([key, value]) => JSON.stringify(event.message.body.after[key]) === JSON.stringify(value)))).toBe(true));
	await new Promise(resolve => setTimeout(resolve, 200));
}

const setups: Record<string, Record<string, string[]>> = {
	sensitive: { sensitiveWords: ['needle'] },
	prohibited: { prohibitedWords: ['forbidden'] },
};
const resets: Record<string, Record<string, string[]>> = {
	sensitive: { sensitiveWords: [] },
	prohibited: { prohibitedWords: [] },
};

describe('fixed upstream note relation contracts (#170)', () => {
	beforeEach(({ onTestFailed }) => {
		onTestFailed(() => { suiteFailed = true; });
	});
	beforeAll(async () => {
		db = await initTestDb(true);
		redis = new Redis(config.redis);
		await redis.flushdb();
		subscriber = new Redis(config.redis);
		subscriber.on('message', (_channel, text) => events.push(JSON.parse(text)));
		await subscriber.subscribe(config.host);
		for (const name of ['root', 'alice', 'bob', 'carol', 'botter', 'blocker', 'blockee', 'suspended', 'limiter']) {
			actors[name] = await signup({ username: `probe_${name}` });
			expect(actors[name].token).toBeTruthy();
			remember(name, actors[name].id);
		}
		// token の cache に古い値が載らないよう、最初の認証付きリクエストより前に DB で設定する。
		await db.getRepository(MiUser).update(ids.suspended, { isSuspended: true });
		await db.getRepository(MiUser).update(ids.botter, { isBot: true });

		const roleId = genAidx(Date.now());
		await db.getRepository(MiRole).insert({ id: roleId, name: 'mention-limit', description: '', updatedAt: new Date(), lastUsedAt: new Date(), policies: { mentionLimit: { useDefault: false, priority: 1, value: 2 } } });
		await db.getRepository(MiRoleAssignment).insert({ id: genAidx(Date.now()), roleId, userId: ids.limiter });
		for (const body of await db.getRepository(MiRole).find()) {
			await redis.publish(config.host, JSON.stringify({ channel: 'internal', message: { type: 'roleCreated', body } }));
		}
		for (const body of await db.getRepository(MiRoleAssignment).find()) {
			await redis.publish(config.host, JSON.stringify({ channel: 'internal', message: { type: 'userRoleAssigned', body } }));
		}
		await vi.waitFor(async () => {
			expect(((await api('i', {}, actors.limiter)).body as any).policies.mentionLimit).toBe(2);
		});

		for (const [name, type] of [['aliceImage', 'image/png'], ['aliceVideo', 'video/mp4']]) {
			await db.getRepository(MiDriveFile).insert({ id: remember(name, genAidx(Date.now())), userId: ids.alice, md5: '0'.repeat(32), name: `${name}.bin`, type, size: 1, storedInternal: false, url: `http://127.0.0.1:63167/files/${name}`, properties: {} });
		}
		for (const [name, host, url] of [['rwithurl', 'remote.example', 'https://remote.example/@rwithurl'], ['rnourl', 'remote.example', null]] as const) {
			const id = remember(name, genAidx(Date.now()));
			await db.getRepository(MiUser).insert({ id, username: name, usernameLower: name, host, uri: `https://${host}/users/${name}`, inbox: `https://${host}/users/${name}/inbox`, sharedInbox: `https://${host}/inbox`, lastFetchedAt: new Date() });
			await db.getRepository(MiUserProfile).insert({ userId: id, userHost: host, url });
		}
		await db.getRepository(MiNote).insert({ id: remember('remoteNote', genAidx(Date.now())), userId: ids.rwithurl, userHost: 'remote.example', text: 'remote', visibility: 'public', uri: 'https://remote.example/notes/1' });
		await db.getRepository(MiFollowing).insert({ id: genAidx(Date.now()), followerId: ids.alice, followeeId: ids.bob });
		remember('missing', '000000000000000000000000');
		for (const [name, allow] of [['chClosed', false], ['chOpen', true], ['chArchived', true], ['chCount', true]] as const) {
			await db.getRepository(MiChannel).insert({ id: remember(name, genAidx(Date.now())), name, userId: ids.bob, isArchived: false, allowRenoteToExternal: allow });
		}

		expect((await api('blocking/create', { userId: ids.alice }, actors.blocker)).status).toBe(200);
		expect((await api('blocking/create', { userId: ids.blockee }, actors.alice)).status).toBe(200);

		await create('bobPublic', { text: 'bob public' }, 'bob');
		await create('bobOther', { text: 'bob other' }, 'bob');
		await create('bobThreadRoot', { text: 'thread root' }, 'bob');
		await create('bobWhitespaceTarget', { text: 'whitespace target' }, 'bob');
		await create('bobHome', { text: 'bob home', visibility: 'home' }, 'bob');
		await create('bobFollowers', { text: 'bob followers', visibility: 'followers' }, 'bob');
		await create('bobSpecified', { text: 'bob specified', visibility: 'specified', visibleUserIds: [ids.alice] }, 'bob');
		await create('bobLocal', { text: 'bob local', localOnly: true }, 'bob');
		await create('bobPure', { renoteId: ids.bobPublic }, 'bob');
		// 配送対象の specified pure Renote は本家の renderAnnounce が応答外で reject し Vitest を止めるため、localOnly で AP を通さない。
		await create('bobPureSpecified', { renoteId: ids.bobPublic, visibility: 'specified', localOnly: true }, 'bob');
		await create('aliceFollowers', { text: 'alice followers', visibility: 'followers' }, 'alice');
		await create('aliceSpecified', { text: 'alice specified', visibility: 'specified', visibleUserIds: [ids.bob] }, 'alice');
		await create('aliceSpecifiedMention', { text: 'only mentioned @probe_bob', visibility: 'specified', visibleUserIds: [ids.carol] }, 'alice');
		await create('blockerNote', { text: 'blocker' }, 'blocker');
		await create('blockeeNote', { text: 'blockee' }, 'blockee');
		await create('chClosedNote', { text: 'closed channel', channelId: ids.chClosed }, 'bob');
		await create('chOpenNote', { text: 'open channel', channelId: ids.chOpen }, 'bob');
		await create('chArchivedNote', { text: 'archived channel', channelId: ids.chArchived }, 'bob');
		await db.getRepository(MiChannel).update(ids.chArchived, { isArchived: true });
		for (const [name, owner] of [['countBotRenote', 'bob'], ['countBotReply', 'bob'], ['countSelfReply', 'alice'], ['countSelfQuote', 'alice'], ['countOtherQuote', 'bob'], ['countOtherPure', 'bob']]) {
			await create(name, { text: name }, owner);
		}
	}, 120000);

	afterAll(async () => {
		await subscriber?.quit();
		await redis?.quit();
		await db?.destroy();
		if (recording) {
			expect(suiteCompleted && !suiteFailed, 'refuse partial goldens from a failed suite').toBe(true);
			writeFileSync(goldenUrl, `${JSON.stringify(observed, null, 2)}\n`);
		} else {
			expect(Object.keys(observed).sort()).toEqual(Object.keys(expected).sort());
		}
	});

	test('normalization keeps literal text and static error ids', () => {
		const errorId = 'aa6e01d3-a85c-669d-758a-76aab43af334';
		expect(normalize({ text: '2100-01-01T00:00:00.000Z', error: { id: errorId }, mentionedRemoteUsers: '[{"uri":"https://remote.example/users/rnourl"}]' })).toEqual({ text: '2100-01-01T00:00:00.000Z', error: { id: errorId }, mentionedRemoteUsers: '[{"uri":"https://remote.example/users/rnourl"}]' });
		expect(normalize({ threadId: ids.bobPublic, renoteChannelId: ids.chOpen, lastNotedAt: new Date() })).toEqual({ threadId: '$bobPublic', renoteChannelId: '$chOpen', lastNotedAt: '$time' });
	});

	test.each(inputs)('$id', async (entry) => {
		if (entry.setup) {
			await updateMeta(setups[entry.setup]);
		}
		try {
			const actorId = actors[entry.actor].id;
			await settleUser(actorId);
			const before = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
			const response = await call(params(entry.params), entry.actor);
			if (entry.allowServerError) {
				expect(response.status).toBeLessThanOrEqual(500);
			} else {
				expect(response.status).toBeLessThan(500);
			}
			const body: any = response.body;
			if (response.status === 500) {
				// info.e.id は ApiCallService がリクエストごとに生成する値で、互換契約に含めない。
				expect(body.error.info.e.id).toMatch(uuid);
				body.error.info.e.id = '$uuid';
			}
			const note = body?.createdNote;
			if (note) {
				remember(entry.id, note.id);
				await settle(actorId, note, entry.watch);
			}
			const after = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
			if (response.status >= 400) {
				expect(after).toEqual(before);
			}
			const persisted = note ? await saved(note.id) : null;
			const result: Record<string, unknown> = { status: response.status, body, wwwAuthenticate: response.headers.get('www-authenticate'), delta: { notes: after.notes - before.notes, polls: after.polls - before.polls }, saved: persisted };
			if (entry.exactExpiresAt) {
				const expectedAt = new Date(entry.params.poll.expiresAt).toISOString();
				expect(note.poll.expiresAt).toBe(expectedAt);
				expect(persisted?.poll?.expiresAt?.toISOString()).toBe(expectedAt);
				result.exactExpiresAt = { response: note.poll.expiresAt, saved: persisted?.poll?.expiresAt?.toISOString() };
			}
			if (entry.watch) {
				const values = await counters(entry.watch);
				for (const channel of Object.values(values.channels) as { lastNotedAt: Date | null }[]) {
					expect(channel.lastNotedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(new Date(note.createdAt).getTime());
				}
				result.counts = values;
			}
			capture(entry.id, result);
		} finally {
			if (entry.setup) {
				await updateMeta(resets[entry.setup]);
			}
		}
	});

	test('all inputs were recorded', () => {
		expect(inputs.every((entry: { id: string }) => entry.id in observed)).toBe(true);
		suiteCompleted = true;
	});
});
