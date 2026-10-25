/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Copy into the fixed upstream checkout's test/e2e; see README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { beforeAll, beforeEach, afterAll, describe, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { initExtraThreadPool } from '@/boot/common.js';
import { api, signup, createAppToken, initTestDb, startJobQueue } from '../utils.js';
import { loadConfig } from '@/config.js';
import { genAidx } from '@/misc/id/aidx.js';
import { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiPoll } from '@/models/Poll.js';
import { MiRole } from '@/models/Role.js';
import { MiRoleAssignment } from '@/models/RoleAssignment.js';
import { MiMeta } from '@/models/Meta.js';
import { MiApp } from '@/models/App.js';
import { MiAccessToken } from '@/models/AccessToken.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import { MiChannel } from '@/models/Channel.js';
import { MiRelay } from '@/models/Relay.js';
import { MiFollowing } from '@/models/Following.js';
import { MiModerationLog } from '@/models/ModerationLog.js';
import type { DataSource } from 'typeorm';

type Actor = { id: string; token: string };
const config = loadConfig();
if (process.env.NODE_ENV !== 'test' || config.db.host !== '127.0.0.1' || config.db.port !== 55167 || config.db.db !== 'backend_next_test' || config.dbReplications || config.redis.host !== '127.0.0.1' || config.redis.port !== 56167 || config.port !== 61167) {
	throw new Error('Only the dedicated note-167 test configuration is supported.');
}
const inputs = JSON.parse(readFileSync(new URL('./note-http-cases.json', import.meta.url), 'utf8'));
const goldenUrl = new URL('./note-observations.json', import.meta.url);
const recording = process.env.NOTE_PROBE_RECORD === '1';
const expected = recording ? {} : JSON.parse(readFileSync(goldenUrl, 'utf8'));
const observed: Record<string, unknown> = {};
const actors: Record<string, Actor> = {};
const ids: Record<string, string> = {};
const symbols = new Map<string, string>();
let suiteFailed = false;
let suiteCompleted = false;
let db: DataSource;
let redis: Redis;
let subscriber: Redis;
let worker: Awaited<ReturnType<typeof startJobQueue>> | undefined;
const events: any[] = [];
const deliveries: { path: string; activity: any; signed: boolean; digest: boolean }[] = [];
const inbox = createServer(async (request, response) => {
	if (request.method !== 'POST' || !request.url?.startsWith('/inbox/')) {
		response.writeHead(404).end();
		return;
	}
	let text = '';
	for await (const chunk of request) {
		text += chunk;
	}
	deliveries.push({ path: request.url, activity: JSON.parse(text), signed: typeof request.headers.signature === 'string', digest: typeof request.headers.digest === 'string' });
	response.writeHead(202).end();
});

function remember(name: string, id: string): string {
	ids[name] = id;
	symbols.set(id, `$${name}`);
	return id;
}

const idFields = new Set(['id', 'userId', 'noteId', 'noteUserId', 'replyId', 'renoteId', 'channelId', 'fileIds', 'visibleUserIds', 'mentions']);
const timeFields = new Set(['createdAt', 'expiresAt', 'published', 'deletedAt', 'created']);
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
		if (key === 'channel' && value.startsWith('noteStream:')) {
			const id = value.slice('noteStream:'.length);
			return `noteStream:${symbols.get(id) ?? id}`;
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
		return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, field === 'signatureValue' ? '$signature' : field === 'nonce' ? '$nonce' : normalize(item, field)]));
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
		if (value.$repeat) {
			return value.$repeat[0].repeat(value.$repeat[1]);
		}
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

async function call(endpoint: string, input: any, actor: string | null = 'alice') {
	return api(`notes/${endpoint}` as never, input, actor ? actors[actor] : undefined);
}

async function create(name: string, input: any, actor = 'alice'): Promise<any> {
	const response = await call('create', input, actor);
	expect(response.status, JSON.stringify(response.body)).toBe(200);
	remember(name, (response.body as any).createdNote.id);
	return (response.body as any).createdNote;
}

async function saved(noteId: string) {
	const note = await db.getRepository(MiNote).findOneByOrFail({ id: noteId });
	const poll = await db.getRepository(MiPoll).findOneBy({ noteId });
	const { id, text, cw, visibility, localOnly, reactionAcceptance, fileIds, replyId, renoteId, channelId, visibleUserIds, mentions, tags, emojis, hasPoll } = note;
	return { id, text, cw, visibility, localOnly, reactionAcceptance, fileIds, replyId, renoteId, channelId, visibleUserIds, mentions, tags, emojis, hasPoll, poll: poll ? { choices: poll.choices, multiple: poll.multiple, expiresAt: poll.expiresAt, votes: poll.votes } : null };
}

async function refreshRoles() {
	for (const body of await db.getRepository(MiRole).find()) {
		await redis.publish(config.host, JSON.stringify({ channel: 'internal', message: { type: 'roleCreated', body } }));
	}
	for (const body of await db.getRepository(MiRoleAssignment).find()) {
		await redis.publish(config.host, JSON.stringify({ channel: 'internal', message: { type: 'userRoleAssigned', body } }));
	}
}

describe('fixed upstream note contracts', () => {
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
		for (const name of ['root', 'alice', 'bob', 'outsider', 'follower', 'suspended', 'moved', 'limited', 'moderator']) {
			actors[name] = await signup({ username: `probe_${name}` });
			expect(actors[name].token).toBeTruthy();
			remember(name, actors[name].id);
		}
		await db.getRepository(MiUser).update(ids.suspended, { isSuspended: true });
		await db.getRepository(MiUser).update(ids.moved, { movedToUri: 'https://moved.invalid/users/new' });
		actors.invalid = { id: ids.alice, token: 'invalid-test-only' };
		actors.noScope = { id: ids.alice, token: await createAppToken(actors.alice, []) };
		actors.writeScope = { id: ids.alice, token: await createAppToken(actors.alice, ['write:notes']) };
		for (const [name, permission, tokenPermission] of [['appWrite', ['write:notes'], []], ['appDenied', [], ['write:notes']]] as const) {
			const appId = genAidx(Date.now());
			await db.getRepository(MiApp).insert({ id: appId, name, description: '', secret: 'test-only', permission: [...permission] });
			await db.getRepository(MiAccessToken).insert({ id: genAidx(Date.now()), appId, userId: ids.alice, token: `${name}-token`, hash: `${name.toLowerCase()}-hash`, permission: [...tokenPermission] });
			actors[name] = { id: ids.alice, token: `${name.toUpperCase()}-HASH` };
		}
		for (const name of ['limited', 'moderator']) {
			const roleId = genAidx(Date.now());
			await db.getRepository(MiRole).insert({ id: roleId, name, description: '', updatedAt: new Date(), lastUsedAt: new Date(), isModerator: name === 'moderator', policies: name === 'limited' ? { canPublicNote: { useDefault: false, priority: 1, value: false } } : {} });
			await db.getRepository(MiRoleAssignment).insert({ id: genAidx(Date.now()), roleId, userId: ids[name] });
		}
		await refreshRoles();
		await vi.waitFor(async () => {
			expect((await api('admin/roles/list', {}, actors.moderator)).status).toBe(200);
		});
		for (const [name, owner] of [['aliceFile1', 'alice'], ['aliceFile2', 'alice'], ['bobFile', 'bob']]) {
			await db.getRepository(MiDriveFile).insert({ id: remember(name, genAidx(Date.now())), userId: ids[owner], md5: '0'.repeat(32), name: `${name}.png`, type: 'image/png', size: 1, storedInternal: false, url: `http://127.0.0.1:63167/files/${name}.png`, properties: {} });
		}
		await db.getRepository(MiFollowing).insert({ id: genAidx(Date.now()), followerId: ids.follower, followeeId: ids.bob });
		remember('missing', '000000000000000000000000');
		for (const [name, archived] of [['channel', false], ['archived', true]] as const) {
			await db.getRepository(MiChannel).insert({ id: remember(name, genAidx(Date.now())), name, userId: ids.alice, isArchived: archived, allowRenoteToExternal: false });
		}
		await db.getRepository(MiRelay).insert({ id: genAidx(Date.now()), inbox: 'http://127.0.0.1:63167/inbox/relay', status: 'accepted' });
		await create('base', { text: 'base' }, 'bob');
		await create('pure', { renoteId: ids.base }, 'bob');
		await create('private', { text: 'private', visibility: 'specified', visibleUserIds: [ids.bob] }, 'bob');
		await create('channelNote', { text: 'channel', channelId: ids.channel }, 'bob');
	}, 120000);

	afterAll(async () => {
		await worker?.close();
		if (inbox.listening) {
			await new Promise<void>((resolve, reject) => inbox.close(error => error ? reject(error) : resolve()));
		}
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

	test('normalization preserves literal text, hashes and error UUIDs', () => {
		const dateText = '2026-10-24T00:00:00.000Z';
		const md5 = '0'.repeat(32);
		const errorId = '24fcbfc6-2e37-42b6-8388-c29b3861a08d';
		expect(normalize({ text: dateText, md5, error: { id: errorId } })).toEqual({ text: dateText, md5, error: { id: errorId } });
		expect(normalize({ id: ids.alice, createdAt: dateText, uri: `${config.url}/users/${ids.alice}#main-key` })).toEqual({ id: '$alice', createdAt: '$time', uri: '$origin/users/$alice#main-key' });
		expect(normalize({ content: `<p>quote <a href="${config.url}/notes/${ids.base}">${config.url}/notes/${ids.base}</a></p>` })).toEqual({ content: '<p>quote <a href="$origin/notes/$base">$origin/notes/$base</a></p>' });
	});

	test.each(inputs)('$id', async (entry) => {
		if (entry.setup === 'sensitive') {
			expect((await api('admin/update-meta', { sensitiveWords: ['needle'] }, actors.root)).status).toBe(204);
		}
		const before = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
		const startedAt = Date.now();
		const response = await call(entry.endpoint, params(entry.params), entry.actor);
		const finishedAt = Date.now();
		expect(response.status).toBeLessThan(500);
		const note = (response.body as any)?.createdNote;
		if (note) {
			remember(entry.id, note.id);
		}
		const after = { notes: await db.getRepository(MiNote).count(), polls: await db.getRepository(MiPoll).count() };
		if (response.status >= 400) {
			expect(after).toEqual(before);
		}
		const persisted = note ? await saved(note.id) : null;
		if (entry.id === 'C7-relative-priority' && note) {
			const expiresAt = new Date(note.poll.expiresAt).getTime();
			expect(expiresAt).toBeGreaterThanOrEqual(startedAt + 600000);
			expect(expiresAt).toBeLessThanOrEqual(finishedAt + 600000);
			expect(persisted?.poll?.expiresAt?.getTime()).toBe(expiresAt);
		}
		capture(entry.id, { status: response.status, body: response.body, wwwAuthenticate: response.headers.get('www-authenticate'), delta: { notes: after.notes - before.notes, polls: after.polls - before.polls }, saved: persisted });
	});

	test('C1 show and user note count settle after creation', async () => {
		capture('C1-show', await minimal('show', { noteId: ids['C1-basic'] }));
		const before = await db.getRepository(MiUser).findOneByOrFail({ id: ids.outsider });
		await create('counter-note', { text: 'count' }, 'outsider');
		await vi.waitFor(async () => expect((await db.getRepository(MiUser).findOneByOrFail({ id: ids.outsider })).notesCount).toBe(before.notesCount + 1));
		const after = await db.getRepository(MiUser).findOneByOrFail({ id: ids.outsider });
		expect((await call('delete', { noteId: ids['counter-note'] }, 'outsider')).status).toBe(204);
		const deleted = await db.getRepository(MiUser).findOneByOrFail({ id: ids.outsider });
		capture('C1-user-count', { before: before.notesCount, afterCreate: after.notesCount, afterDelete: deleted.notesCount });
	});

	test('C2 read/delete exceptions and token/header validation order', async () => {
		capture('C2-suspended-show', await minimal('show', { noteId: ids.base }, 'suspended'));
		const note = await create('moved-delete', { text: 'delete moved' }, 'outsider');
		await db.getRepository(MiNote).update(note.id, { userId: ids.moved });
		capture('C2-moved-delete', await minimal('delete', { noteId: note.id }, 'moved'));
		const response = await fetch(`${config.url}/api/notes/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actors.alice.token}` }, body: JSON.stringify({ noteId: ids.base, i: actors.invalid.token }) });
		capture('C2-bearer-precedence', { status: response.status, body: await response.json() });
	});

	test('C5 viewer-specific hidden/detail, nested notes, guest restrictions', async () => {
		for (const visibility of ['followers', 'specified']) {
			const note = await create(`show-${visibility}`, { text: 'secret @probe_alice', cw: 'cw', visibility, visibleUserIds: [ids.alice], fileIds: [ids.bobFile], poll: { choices: ['a', 'b'] } }, 'bob');
			for (const actor of ['bob', 'follower', 'alice', 'outsider', null]) {
				const response = await call('show', { noteId: note.id }, actor);
				capture(`C5-${visibility}-${actor ?? 'guest'}`, { status: response.status, body: response.body });
			}
		}
		const reply = await create('show-reply', { text: 'reply', visibility: 'followers', replyId: ids.base });
		capture('C5-reply-author', (await call('show', { noteId: reply.id }, 'bob')).body);
		capture('C5-missing', await minimal('show', { noteId: ids.missing }, null));
		await db.getRepository(MiUser).update(ids.bob, { requireSigninToViewContents: true });
		capture('C5-user-restricted', await minimal('show', { noteId: ids.base }, null));
		await db.getRepository(MiUser).update(ids.bob, { requireSigninToViewContents: false });
		expect((await api('admin/update-meta', { ugcVisibilityForVisitor: 'none' }, actors.root)).status).toBe(204);
		capture('C5-server-restricted', await minimal('show', { noteId: ids.base }, null));
		expect((await api('admin/update-meta', { ugcVisibilityForVisitor: 'all' }, actors.root)).status).toBe(204);
	});

	test('C5 time restrictions, myReaction, poll vote and removed attachments', async () => {
		const note = await create('detail-note', { text: 'detail', fileIds: [ids.bobFile], poll: { choices: ['a', 'b'] } }, 'bob');
		expect((await api('notes/reactions/create', { noteId: note.id, reaction: '❤' }, actors.alice)).status).toBe(204);
		expect((await api('notes/polls/vote', { noteId: note.id, choice: 1 }, actors.alice)).status).toBe(204);
		capture('C5-detail-self', await minimal('show', { noteId: note.id }));
		capture('C5-detail-other', await minimal('show', { noteId: note.id }, 'outsider'));
		await db.getRepository(MiDriveFile).delete(ids.bobFile);
		capture('C5-removed-file', await minimal('show', { noteId: note.id }));
		await db.getRepository(MiUser).update(ids.bob, { makeNotesFollowersOnlyBefore: 0 });
		capture('C5-time-followers-outsider', await minimal('show', { noteId: note.id }, 'outsider'));
		capture('C5-time-followers-author', await minimal('show', { noteId: note.id }, 'bob'));
		await db.getRepository(MiUser).update(ids.bob, { makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: 0 });
		capture('C5-time-hidden-follower', await minimal('show', { noteId: note.id }, 'follower'));
		capture('C5-time-hidden-author', await minimal('show', { noteId: note.id }, 'bob'));
		await db.getRepository(MiUser).update(ids.bob, { makeNotesHiddenBefore: null });
	});

	test('C6 counters after reply, pure Renote and quote', async () => {
		await vi.waitFor(async () => {
			const base = await db.getRepository(MiNote).findOneByOrFail({ id: ids.base });
			expect(base.repliesCount).toBe(2);
			expect(base.renoteCount).toBe(2);
		});
		const base = await db.getRepository(MiNote).findOneByOrFail({ id: ids.base });
		capture('C6-counts', { repliesCount: base.repliesCount, renoteCount: base.renoteCount });
	});

	test('C8 channel usersCount after deleting all posts then posting again', async () => {
		const note = await create('channel-first', { text: 'one', channelId: ids.channel });
		await vi.waitFor(async () => expect((await db.getRepository(MiChannel).findOneByOrFail({ id: ids.channel })).notesCount).toBe(3));
		const before = await db.getRepository(MiChannel).findOneByOrFail({ id: ids.channel });
		expect((await call('delete', { noteId: ids['C8-channel'] })).status).toBe(204);
		expect((await call('delete', { noteId: note.id })).status).toBe(204);
		const afterDelete = await db.getRepository(MiChannel).findOneByOrFail({ id: ids.channel });
		await create('channel-again', { text: 'again', channelId: ids.channel });
		await vi.waitFor(async () => expect((await db.getRepository(MiChannel).findOneByOrFail({ id: ids.channel })).usersCount).toBe(before.usersCount + 1));
		const afterAgain = await db.getRepository(MiChannel).findOneByOrFail({ id: ids.channel });
		capture('C8-channel-counts', { before: { notes: before.notesCount, users: before.usersCount }, afterDelete: { notes: afterDelete.notesCount, users: afterDelete.usersCount }, afterAgain: { notes: afterAgain.notesCount, users: afterAgain.usersCount } });
	});

	test('C10 deletion authorization, persisted audit and deleted Redis stream', async () => {
		const note = await create('delete-target', { text: 'delete' });
		capture('C10-other', await minimal('delete', { noteId: note.id }, 'outsider'));
		expect(await db.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		const start = events.length;
		capture('C10-author', await minimal('delete', { noteId: note.id }));
		expect(await db.getRepository(MiNote).existsBy({ id: note.id })).toBe(false);
		await vi.waitFor(() => expect(events.slice(start).some(event => event.channel === `noteStream:${note.id}` && event.message.type === 'deleted')).toBe(true));
		capture('C10-deleted-stream', events.slice(start).filter(event => event.channel === `noteStream:${note.id}`));
		capture('C10-repeat', await minimal('delete', { noteId: note.id }));
		const moderated = await create('moderated-target', { text: 'moderated' });
		capture('C10-moderator', await minimal('delete', { noteId: moderated.id }, 'moderator'));
		await vi.waitFor(async () => expect(await db.getRepository(MiModerationLog).countBy({ type: 'deleteNote' })).toBe(1));
		const log = await db.getRepository(MiModerationLog).findOneByOrFail({ type: 'deleteNote' });
		capture('C10-audit', { userId: log.userId, type: log.type, noteId: log.info.noteId, noteUserId: log.info.noteUserId, noteUserUsername: log.info.noteUserUsername, noteUserHost: log.info.noteUserHost });
	});

	test('C9/C10 real worker delivers signed Create/Announce/Delete/Undo to fake inbox only', async () => {
		await db.getRepository(MiMeta).createQueryBuilder().update().set({ enableStatsForFederatedInstances: false, enableChartsForFederatedInstances: false }).execute();
		for (const name of ['remote1', 'remote2']) {
			const id = remember(name, genAidx(Date.now()));
			await db.getRepository(MiUser).insert({ id, username: name, usernameLower: name, host: '127.0.0.1:63167', uri: `http://127.0.0.1:63167/users/${name}`, inbox: `http://127.0.0.1:63167/inbox/${name}`, sharedInbox: 'http://127.0.0.1:63167/inbox/shared' });
			await db.getRepository(MiFollowing).insert({ id: genAidx(Date.now()), followerId: id, followeeId: ids.alice, followerHost: '127.0.0.1:63167', followerInbox: `http://127.0.0.1:63167/inbox/${name}`, followerSharedInbox: 'http://127.0.0.1:63167/inbox/shared' });
		}
		initExtraThreadPool(config);
		inbox.listen(63167, '127.0.0.1');
		await once(inbox, 'listening');
		// A second test-mode DataSource drops the schema; production mode preserves it.
		const mode = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			worker = await startJobQueue();
		} finally {
			process.env.NODE_ENV = mode;
		}
		await db.getRepository(MiNote).insert({ id: remember('remote-base', genAidx(Date.now())), userId: ids.remote1, userHost: '127.0.0.1:63167', text: 'remote', visibility: 'public', uri: 'http://127.0.0.1:63167/notes/remote-base' });
		for (const visibility of ['public', 'home', 'followers', 'specified']) {
			const name = `ap-${visibility}`;
			const note = await create(name, { text: 'AP contract', ...(visibility === 'public' ? { replyId: ids['remote-base'] } : {}), visibility, visibleUserIds: [ids.remote1] });
			const paths = visibility === 'public' ? ['/inbox/relay', '/inbox/shared'] : visibility === 'specified' ? ['/inbox/remote1'] : ['/inbox/shared'];
			await vi.waitFor(() => expect(forNote(note.id, 'Create').map(x => x.path).sort()).toEqual(paths), { timeout: 20000 });
			capture(`C9-${visibility}`, forNote(note.id, 'Create').sort((a, b) => a.path.localeCompare(b.path)));
		}
		const local = await create('ap-local', { text: 'local', localOnly: true });
		const pure = await create('ap-pure', { renoteId: ids.base });
		await vi.waitFor(() => expect(forNote(pure.id, 'Announce').length).toBe(2), { timeout: 20000 });
		capture('C9-pure', forNote(pure.id, 'Announce').sort((a, b) => a.path.localeCompare(b.path)));
		const quote = await create('ap-quote', { text: 'quote', renoteId: ids.base });
		await vi.waitFor(() => expect(forNote(quote.id, 'Create').length).toBe(2), { timeout: 20000 });
		capture('C9-quote', forNote(quote.id, 'Create').sort((a, b) => a.path.localeCompare(b.path)));
		for (const [name, type] of [['ap-public', 'Delete'], ['ap-pure', 'Undo']] as const) {
			expect((await call('delete', { noteId: ids[name] })).status).toBe(204);
			await vi.waitFor(() => expect(forNote(ids[name], type).length).toBe(name === 'ap-public' ? 3 : 2), { timeout: 20000 });
			capture(`C10-${type}`, forNote(ids[name], type).sort((a, b) => a.path.localeCompare(b.path)));
		}
		const fallbackBase = await create('fallback-base', { text: 'fallback' }, 'bob');
		const fallback = await create('fallback-renote', { renoteId: fallbackBase.id });
		await vi.waitFor(() => expect(forNote(fallback.id, 'Announce').length).toBe(2), { timeout: 20000 });
		await call('delete', { noteId: fallbackBase.id }, 'bob');
		expect((await call('delete', { noteId: fallback.id })).status).toBe(204);
		await vi.waitFor(() => expect(forNote(fallback.id, 'Delete').length).toBe(2), { timeout: 20000 });
		capture('C10-fallback', forNote(fallback.id, 'Delete').sort((a, b) => a.path.localeCompare(b.path)));

		await db.getRepository(MiUser).insert({ id: remember('late', genAidx(Date.now())), username: 'late', usernameLower: 'late', host: '127.0.0.1:63167', uri: 'http://127.0.0.1:63167/users/late', inbox: 'http://127.0.0.1:63167/inbox/late' });
		await db.getRepository(MiFollowing).insert({ id: genAidx(Date.now()), followerId: ids.late, followeeId: ids.alice, followerHost: '127.0.0.1:63167', followerInbox: 'http://127.0.0.1:63167/inbox/late' });
		for (const visibility of ['home', 'followers', 'specified']) {
			const noteId = ids[`ap-${visibility}`];
			expect((await call('delete', { noteId })).status).toBe(204);
			const paths = visibility === 'specified' ? ['/inbox/late', '/inbox/relay', '/inbox/remote1', '/inbox/shared'] : ['/inbox/late', '/inbox/relay', '/inbox/shared'];
			await vi.waitFor(() => expect(forNote(noteId, 'Delete').map(x => x.path).sort()).toEqual(paths), { timeout: 20000 });
			capture(`F8-upstream-${visibility}`, forNote(noteId, 'Delete').sort((a, b) => a.path.localeCompare(b.path)));
		}
		// Drain positive deliveries before observing the bounded localOnly absence window.
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(deliveries.filter(x => JSON.stringify(x.activity).includes(local.id))).toEqual([]);
		capture('C9-localOnly', { deliveries: [] });
		suiteCompleted = true;
	}, 120000);
});

async function minimal(endpoint: string, input: any, actor: string | null = 'alice') {
	const response = await call(endpoint, input, actor);
	return { status: response.status, body: response.body };
}

function forNote(noteId: string, type: string) {
	const receipts = deliveries.filter(entry => entry.activity.type === type && JSON.stringify(entry.activity).includes(`/notes/${noteId}`));
	const activityIds = new Set(receipts.map(entry => entry.activity.id));
	expect(activityIds.size).toBeLessThanOrEqual(1);
	for (const id of activityIds) {
		const suffix = id?.slice(config.url.length + 1);
		if (id?.startsWith(`${config.url}/`) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)) {
			remember(`activity-${type}-${symbols.get(noteId)}`, suffix);
		}
	}
	return receipts;
}
