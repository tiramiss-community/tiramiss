/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiNote, MiUser, MiMeta, MiDriveFile, MiPoll, MiPollVote, MiNoteReaction, MiFollowing, MiAccessToken, MiRole, MiRoleAssignment, MiAvatarDecoration, MiInstance, MiEmoji, MiChannel, MiApp } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createNoteReader } from '../../src/platform/database/note-reader.js';
import { readNotePlan, renderNote } from '../../src/modules/note/public.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createTestDatabase } from '../helpers/database.js';

const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
const codec = createIdCodec('aidx');
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const symbols = new Map<string, string>();
const idFields = new Set(['id', 'userId', 'noteId', 'replyId', 'renoteId', 'fileIds', 'visibleUserIds', 'mentions']);

function normalize(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) {
		return value.map(x => normalize(x, key));
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
	}
	if (typeof value === 'string') {
		if (idFields.has(key) && symbols.has(value)) {
			return symbols.get(value);
		}
		if (['createdAt', 'expiresAt'].includes(key)) {
			return '$time';
		}
		return value.replaceAll(database.config.url, '$origin');
	}
	return value;
}

function remember(name: string) {
	const id = codec.newId(Date.now() - 10000);
	ids[name] = id;
	symbols.set(id, `$${name}`);
	return id;
}

async function call(name: string, actor: string | null = 'alice', extra: object = {}, authorization?: string) {
	return app.request('/api/notes/show', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify({ noteId: ids[name] ?? name, i: actor ? tokens[actor] : undefined, ...extra }) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	database.config.url = 'http://127.0.0.1:61167';
	await migrateDatabase(database.config.database);
	await assertSchemaMatches(database.config.database);
	resources = await connectResources(database.config, createLogger('note-test', () => {}));
	const db = resources.dataSource;
	for (const [index, name] of ['alice', 'bob', 'follower', 'outsider', 'suspended', 'moved'].entries()) {
		tokens[name] = `native${String(index).padStart(10, '0')}`;
		await db.getRepository(MiUser).insert({ id: remember(name), username: `probe_${name}`, usernameLower: `probe_${name}`, token: tokens[name], isSuspended: name === 'suspended', movedToUri: name === 'moved' ? 'https://other.test/moved' : null });
	}
	await db.getRepository(MiMeta).insert({ id: 'singleton', ugcVisibilityForVisitor: 'all' });
	await db.getRepository(MiDriveFile).insert({ id: remember('bobFile'), userId: ids.bob, md5: '0'.repeat(32), name: 'bobFile.png', type: 'image/png', size: 1, storedInternal: false, url: 'http://127.0.0.1:63167/files/bobFile.png', properties: {} });
	await db.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: ids.follower, followeeId: ids.bob });
	await db.getRepository(MiNote).insert({ id: remember('base'), userId: ids.bob, text: 'base', visibility: 'public', repliesCount: 2, renoteCount: 2 });
	for (const visibility of ['followers', 'specified'] as const) {
		const id = remember(`show-${visibility}`);
		await db.getRepository(MiNote).insert({ id, userId: ids.bob, text: 'secret @probe_alice', cw: 'cw', visibility, visibleUserIds: visibility === 'specified' ? [ids.alice] : [], mentions: [ids.alice], fileIds: [ids.bobFile], hasPoll: true });
		await db.getRepository(MiPoll).insert({ noteId: id, userId: ids.bob, choices: ['a', 'b'], votes: [0, 0], multiple: false, noteVisibility: visibility });
	}
	await db.getRepository(MiNote).insert({ id: remember('show-reply'), userId: ids.alice, text: 'reply', visibility: 'followers', replyId: ids.base, replyUserId: ids.bob, mentions: [ids.bob] });
	await db.getRepository(MiNote).insert({ id: remember('detail-note'), userId: ids.bob, text: 'detail', visibility: 'public', fileIds: [ids.bobFile], hasPoll: true, reactions: { '❤': 1 }, reactionAndUserPairCache: [`${ids.alice}/❤`] });
	await db.getRepository(MiPoll).insert({ noteId: ids['detail-note'], userId: ids.bob, choices: ['a', 'b'], votes: [0, 1], multiple: false, noteVisibility: 'public' });
	await db.getRepository(MiPollVote).insert({ id: codec.newId(Date.now()), noteId: ids['detail-note'], userId: ids.alice, choice: 1 });
	await db.getRepository(MiNoteReaction).insert({ id: codec.newId(Date.now()), noteId: ids['detail-note'], userId: ids.alice, reaction: '❤' });
	await db.getRepository(MiAccessToken).insert({ id: codec.newId(Date.now()), userId: ids.alice, token: 'empty-scope-token', hash: 'empty-scope-hash', permission: [] });
	tokens.emptyScope = 'empty-scope-token';
	app = createBackendHttpApp(resources, database.config);
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
});

test.each(['followers', 'specified'].flatMap(visibility => ['bob', 'follower', 'alice', 'outsider', null].map(actor => ({ visibility, actor }))))('C5 $visibility/$actor equals pinned full JSON', async ({ visibility, actor }) => {
	const response = await call(`show-${visibility}`, actor);
	expect({ status: response.status, body: normalize(await response.json()) }).toEqual(golden[`C5-${visibility}-${actor ?? 'guest'}`]);
});

test('C5 reply-author, detail self and other equal pinned full JSON', async () => {
	const reply = await call('show-reply', 'bob');
	expect(reply.status).toBe(200);
	expect(normalize(await reply.json())).toEqual(golden['C5-reply-author']);
	for (const [key, actor] of [['self', 'alice'], ['other', 'outsider']]) {
		const response = await call('detail-note', actor);
		expect({ status: response.status, body: normalize(await response.json()) }).toEqual(golden[`C5-detail-${key}`]);
	}
});

test('C5 missing, author and server error order equals pinned errors', async () => {
	let response = await call('000000000000000000000000', null);
	expect({ status: response.status, body: await response.json() }).toEqual(golden['C5-missing']);
	expect(response.headers.get('www-authenticate')).toBe('Bearer realm="Misskey", error="invalid_request", error_description="No such note."');
	await resources.dataSource.getRepository(MiUser).update(ids.bob, { requireSigninToViewContents: true });
	await resources.dataSource.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'none' });
	response = await call('base', null);
	expect({ status: response.status, body: await response.json() }).toEqual(golden['C5-user-restricted']);
	await resources.dataSource.getRepository(MiUser).update(ids.bob, { requireSigninToViewContents: false });
	response = await call('base', null);
	expect({ status: response.status, body: await response.json() }).toEqual(golden['C5-server-restricted']);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'all' });
});

test('show accepts suspended/moved/scope-free identities, rejects invalid bearer before schema and GET', async () => {
	for (const actor of ['suspended', 'moved', 'emptyScope']) {
		expect((await call('base', actor)).status).toBe(200);
	}
	expect((await call('base', 'emptyScope', {}, `Bearer ${tokens.alice}`)).status).toBe(200);
	const invalid = await call('base', 'alice', { noteId: null }, 'Bearer invalid');
	expect(invalid.status).toBe(401);
	expect(await invalid.json()).toHaveProperty('error.code', 'AUTHENTICATION_FAILED');
	const schema = await call('base', null, { noteId: null });
	expect(schema.status).toBe(400);
	expect(await schema.json()).toHaveProperty('error.code', 'INVALID_PARAM');
	const get = await app.request('/api/notes/show');
	expect(get.status).toBe(405);
	expect(await get.text()).toBe('');
});

test('C5 removed attachment and time-boundary output equal pinned full JSON', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiDriveFile).delete(ids.bobFile);
	let response = await call('detail-note');
	expect({ status: response.status, body: normalize(await response.json()) }).toEqual(golden['C5-removed-file']);
	await db.getRepository(MiUser).update(ids.bob, { makeNotesFollowersOnlyBefore: 0 });
	for (const [key, actor] of [['outsider', 'outsider'], ['author', 'bob']]) {
		response = await call('detail-note', actor);
		expect({ status: response.status, body: normalize(await response.json()) }).toEqual(golden[`C5-time-followers-${key}`]);
	}
	await db.getRepository(MiUser).update(ids.bob, { makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: 0 });
	for (const [key, actor] of [['follower', 'follower'], ['author', 'bob']]) {
		response = await call('detail-note', actor);
		expect({ status: response.status, body: normalize(await response.json()) }).toEqual(golden[`C5-time-hidden-${key}`]);
	}
	await db.getRepository(MiUser).update(ids.bob, { makeNotesHiddenBefore: null });
});

test('nested detail roles, shared references, missing targets, cycles and excessive depth through HTTP', async () => {
	const db = resources.dataSource;
	const target = remember('nested-target');
	await db.getRepository(MiNote).insert({ id: target, userId: ids.bob, visibility: 'public', text: 'nested', replyId: ids['detail-note'], hasPoll: true });
	await db.getRepository(MiPoll).insert({ noteId: target, userId: ids.bob, choices: ['a', 'b'], votes: [0, 0], multiple: false, noteVisibility: 'public' });
	await db.getRepository(MiNote).insert({ id: remember('nested-root'), userId: ids.alice, visibility: 'specified', replyId: target, renoteId: target });
	let response = await call('nested-root', 'outsider');
	const body = await response.json();
	expect(body).toMatchObject({ isHidden: true, reply: { id: target, hasPoll: true }, renote: { id: target, hasPoll: true, poll: { multiple: false }, reply: { id: ids['detail-note'] } } });
	expect(body.reply).not.toHaveProperty('poll');
	expect(body.reply).not.toHaveProperty('reply');
	await db.getRepository(MiNote).update(target, { renoteId: 'missing', replyId: 'missing' });
	response = await call('nested-root');
	expect(await response.json()).toMatchObject({ renote: { renote: null, reply: null } });
	await db.getRepository(MiNote).update(target, { renoteId: ids['nested-root'] });
	expect((await call('nested-root')).status).toBe(500);
	const chain = Array.from({ length: 65 }, (_, i) => ({ id: remember(`depth-${i}`), userId: ids.bob, visibility: 'public' as const }));
	await db.getRepository(MiNote).insert(chain.map((n, i) => ({ ...n, renoteId: chain[i + 1]?.id ?? null })));
	expect((await call('depth-0')).status).toBe(500);
});

test('remote guest server=local differs between root and nested note; remote author fields are populated', async () => {
	const db = resources.dataSource;
	const remote = remember('remote');
	await db.getRepository(MiUser).insert({ id: remote, username: 'remote', usernameLower: 'remote', host: 'remote.test', emojis: ['blob'], lastActiveDate: new Date() });
	await db.getRepository(MiInstance).insert({ id: codec.newId(Date.now()), host: 'remote.test', firstRetrievedAt: new Date(), name: 'remote instance' });
	await db.getRepository(MiEmoji).insert({ id: codec.newId(Date.now()), host: 'remote.test', name: 'blob', originalUrl: 'https://remote.test/blob.png', publicUrl: '' });
	await db.getRepository(MiNote).insert({ id: remember('remote-note'), userId: remote, userHost: 'remote.test', text: 'remote content', visibility: 'public', emojis: ['blob'] });
	await db.getRepository(MiNote).insert({ id: remember('local-quote'), userId: ids.alice, visibility: 'public', renoteId: ids['remote-note'] });
	await db.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'local' });
	expect((await call('remote-note', null)).status).toBe(400);
	const response = await call('local-quote', null);
	expect(await response.json()).toMatchObject({ renote: { text: 'remote content', emojis: { blob: 'https://remote.test/blob.png' }, user: { instance: { name: 'remote instance' }, emojis: { blob: 'https://remote.test/blob.png' }, onlineStatus: 'online' } } });
	await db.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'all' });
});

test('author badges, decorations and channel use batch materials and moderator visibility', async () => {
	const db = resources.dataSource;
	const roleId = remember('badge');
	await db.getRepository(MiRole).insert({ id: roleId, name: 'private badge', description: '', updatedAt: new Date(), lastUsedAt: new Date(), asBadge: true, isPublic: false, displayOrder: 3 });
	await db.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), roleId, userId: ids.bob });
	await db.getRepository(MiMeta).update('singleton', { rootUserId: ids.alice });
	const decoration = remember('decoration');
	await db.getRepository(MiAvatarDecoration).insert({ id: decoration, name: 'decoration', description: '', url: 'https://example.test/decoration.png' });
	await db.getRepository(MiUser).update(ids.bob, { avatarDecorations: [{ id: decoration, angle: 0, flipH: false, offsetX: 0.1, offsetY: 0 }] });
	const channel = remember('channel');
	await db.getRepository(MiChannel).insert({ id: channel, userId: ids.bob, name: 'channel', color: '#112233', isSensitive: true, allowRenoteToExternal: false });
	await db.getRepository(MiNote).insert({ id: remember('channel-note'), userId: ids.bob, visibility: 'public', channelId: channel });
	let response = await call('channel-note', 'alice');
	expect(await response.json()).toMatchObject({ channel: { id: channel, name: 'channel', color: '#112233', isSensitive: true, allowRenoteToExternal: false, userId: ids.bob }, user: { badgeRoles: [{ name: 'private badge', displayOrder: 3, iconUrl: null }], avatarDecorations: [{ id: decoration, offsetX: 0.1, url: 'https://example.test/decoration.png' }] } });
	response = await call('channel-note', 'outsider');
	expect(await response.json()).toHaveProperty('user.badgeRoles', []);
});

test('Redis reaction deltas/pairs and DB fallback are read before pure output', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { enableReactionsBuffering: true });
	await resources.reactionsRedis.hset(`reactionsBufferDeltas:${ids['detail-note']}`, 'like', 1);
	await resources.reactionsRedis.zadd(`reactionsBufferPairs:${ids['detail-note']}`, 1, `${ids.outsider}/like`);
	let response = await call('detail-note', 'outsider');
	expect(await response.json()).toMatchObject({ reactions: { '❤': 1, '👍': 1 }, myReaction: '👍', reactionCount: 2 });
	await resources.reactionsRedis.del(`reactionsBufferDeltas:${ids['detail-note']}`, `reactionsBufferPairs:${ids['detail-note']}`);
	await db.getRepository(MiNote).update(ids['detail-note'], { reactionAndUserPairCache: [] });
	response = await call('detail-note', 'alice');
	expect(await response.json()).toHaveProperty('myReaction', '❤');
});

test('one and twenty roots with distinct authors use the same bounded SQL count and rendering performs no SQL', async () => {
	const db = resources.dataSource;
	const userRows = Array.from({ length: 20 }, (_, i) => ({ id: codec.newId(Date.now() - 10000), username: `batch${i}`, usernameLower: `batch${i}` }));
	await db.getRepository(MiUser).insert(userRows);
	const noteRows = userRows.map(u => ({ id: codec.newId(Date.now() - 10000), userId: u.id, text: 'batch', visibility: 'public' as const, replyId: ids.base, renoteId: ids['detail-note'], fileIds: [] }));
	await db.getRepository(MiNote).insert(noteRows);
	const reader = createNoteReader(db.manager, resources.reactionsRedis, { url: database.config.url, createdAtFromId: codec.createdAtFromId });
	const logger = db.logger;
	const original = logger.logQuery;
	let count = 0;
	logger.logQuery = (...args) => {
		count++;
		original.apply(logger, args);
	};
	try {
		const load = async (rootIds: string[]) => {
			count = 0;
			const notes = await readNotePlan(rootIds, reader.readNotes);
			const m = await reader.readMaterials(notes, ids.alice, Date.now());
			const before = count;
			for (const root of rootIds) {
				expect(renderNote(root, m, ids.alice, Date.now())).toHaveProperty('text', 'batch');
			}
			expect(count).toBe(before);
			return count;
		};
		const single = await load([noteRows[0].id]);
		const batch = await load(noteRows.map(n => n.id));
		expect(batch).toBe(single);
		expect(batch).toBeLessThanOrEqual(16);
	} finally {
		logger.logQuery = original;
	}
});

test('malformed emoji hosts from saved remote posts and authors do not fail show', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiUser).update(ids.remote, { emojis: ['blob@9999999999'] });
	await db.getRepository(MiNote).update(ids['remote-note'], { emojis: ['blob@256.256.256.256'], reactions: { ':blob@9999999999:': 1 } });
	const response = await call('remote-note');
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ emojis: {}, reactionEmojis: {}, user: { emojis: {} } });
});

test('missing poll on root fails but a detailed reference becomes null over HTTP', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiNote).insert({ id: remember('missing-poll'), userId: ids.bob, visibility: 'public', hasPoll: true });
	await db.getRepository(MiNote).insert({ id: remember('quote-missing-poll'), userId: ids.alice, visibility: 'public', renoteId: ids['missing-poll'] });
	expect((await call('missing-poll')).status).toBe(500);
	const response = await call('quote-missing-poll');
	expect(response.status).toBe(200);
	expect(await response.json()).toHaveProperty('renote', null);
});

test('browser JSON requests receive upstream CORS/preflight and private cache headers', async () => {
	const response = await call('base');
	expect(response.headers.get('access-control-allow-origin')).toBe('*');
	expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
	const options = await app.request('/api/notes/show', { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
	expect(options.status).toBe(204);
	expect(options.headers.get('access-control-allow-origin')).toBe('*');
	expect(options.headers.get('access-control-allow-methods')).toBe('GET,HEAD,POST');
	expect(options.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
});

test('C1 plain note show equals pinned JSON and App tokens remain valid without note scopes', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiNote).insert({ id: remember('C1-basic'), userId: ids.alice, text: 'hello', visibility: 'public' });
	const response = await call('C1-basic');
	expect({ status: response.status, body: normalize(await response.json()) }).toEqual(golden['C1-show']);
	const appId = codec.newId(Date.now());
	await db.getRepository(MiApp).insert({ id: appId, name: 'note probe', description: '', secret: 'note-test-only', permission: [] });
	const tokenId = codec.newId(Date.now());
	await db.getRepository(MiAccessToken).insert({ id: tokenId, userId: ids.alice, appId, token: 'note-app-native-token', hash: 'note-app-hash', permission: [] });
	const appResponse = await call('C1-basic', null, { i: 'NOTE-APP-HASH' });
	expect({ status: appResponse.status, body: normalize(await appResponse.json()) }).toEqual(golden['C1-show']);
	expect((await db.getRepository(MiAccessToken).findOneByOrFail({ id: tokenId })).lastUsedAt).not.toBeNull();
});

test.each([false, {}, []])('non-string credential %j ends as empty 400 without guest fallback', async i => {
	const response = await call('base', null, { i });
	expect(response.status).toBe(400);
	expect(await response.text()).toBe('');
});
