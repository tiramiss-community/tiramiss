/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiDriveFile, MiEmoji, MiInstance, MiFollowing, MiMeta, MiNote, MiPoll, MiUser, MiUserProfile, MiUserPublickey, MiUserKeypair } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { startRemotePeer, plainActor, deferred } from '../helpers/remote-peer.js';
import { remoteSource, decode } from '../helpers/remote-source.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let peer: Awaited<ReturnType<typeof startRemotePeer>>;
let server: Server;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const realNow = Date.now;
const clock = vi.spyOn(Date, 'now');
let authorId: string;
const token = 'remote243native1';
const actors = new Map<string, Record<string, unknown>>();
const aliases = new Map<string, string>();
const links = new Map<string, { rel: string; href: string; type?: string; }[]>();
const statuses = new Map<string, number>();
let port: number;
const hashtagLogs: string[] = [];
let actorBarrier: { paths: Set<string>; count: number; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;

beforeAll(async () => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	peer = await startRemotePeer();
	database.config.url = 'http://local.test';
	database.config.outboundHttp.proxy = peer.proxy;
	resources = await connectResources(database.config, createLogger('remote-test', line => hashtagLogs.push(line)));
	authorId = codec.newId(Date.now() - 100000);
	const pair = await generateRsaKeyPair();
	await resources.dataSource.getRepository(MiUser).insert({ id: authorId, username: 'author', usernameLower: 'author', token });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: authorId });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: authorId, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	app = createBackendHttpApp(resources, database.config);
	server = await listenHttp(app, { port: 0 }); port = (server.address() as { port: number; }).port;
	peer.route('local.test', port);
	peer.respond(async req => {
		const url = new URL(req.path, peer.origin);
		if (url.pathname === '/.well-known/webfinger') {
			const name = url.searchParams.get('resource')!.slice(5).split('@')[0];
			const target = aliases.get(name) ?? name;
			if (statuses.has('webfinger:' + name)) {
				return { status: statuses.get('webfinger:' + name) };
			}
			return { type: 'application/jrd+json', body: { links: links.get(name) ?? [{ rel: 'SeLf', type: 'text/html', href: `${peer.origin}/users/${target}` }] } };
		}
		if (req.method === 'POST') {
			return { body: {} };
		}
		if (statuses.has(url.pathname)) {
			return { status: statuses.get(url.pathname), body: {} };
		}
		if (actorBarrier?.paths.has(url.pathname)) {
			actorBarrier.count++; if (actorBarrier.count === 2) {
				actorBarrier.entered.resolve();
			}
			await actorBarrier.release.promise;
		}
		const actor = actors.get(url.pathname);
		return actor ? { body: actor } : { status: 404, body: {} };
	});
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} await resources?.close(); await peer?.close(); await database?.close(); vi.unstubAllEnvs(); clock.mockRestore();
});

function register(name: string, patch: Record<string, unknown> = {}) {
	const value = plainActor(peer.origin, name, patch); actors.set(`/users/${name}`, value); return value;
}

async function post(input: Record<string, unknown>, credential: string | null = token) {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: credential, ...input }) });
	return { status: response.status, body: await response.json() };
}

async function remote(name: string) {
	return resources.dataSource.getRepository(MiUser).findOneByOrFail({ usernameLower: name, host: 'remote.test' });
}

async function stale(id: string) {
	await resources.dataSource.getRepository(MiUser).update(id, { lastFetchedAt: new Date(Date.now() - 86400001) });
}

async function failWrites(table: string) {
	const db = resources.dataSource;
	await db.query(`CREATE FUNCTION remote243_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ${table} failure'; END $$`);
	await db.query(`CREATE TRIGGER remote243_fail BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION remote243_fail()`);
	return async () => {
		await db.query(`DROP TRIGGER remote243_fail ON "${table}"`); await db.query('DROP FUNCTION remote243_fail()');
	};
}

test.each(['text', 'cw', 'poll'])('native token unknown success in %s saves actor/profile, snapshots, input and show', async field => {
	const name = `acquired_${field}`;
	register(name, { summary: '<p>Hello <b>peer</b></p>', _misskey_summary: undefined, attachment: [{ type: 'PropertyValue', name: 'site', value: '<b>real</b>' }] });
	const mention = `@${name}@remote.test`;
	const result = await post({ text: field === 'text' ? mention : 'retained', ...(field === 'cw' ? { cw: mention } : {}), ...(field === 'poll' ? { poll: { choices: [mention, 'other'] } } : {}) });
	expect(result.status, JSON.stringify(result.body)).toBe(200);
	const row = await remote(name);
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
	expect(profile).toMatchObject({ url: `${peer.origin}/@${name}`, description: 'Hello **peer**', fields: [{ name: 'site', value: '**real**' }] });
	const saved = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id });
	expect(saved.mentions).toEqual([row.id]);
	expect(JSON.parse(saved.mentionedRemoteUsers)).toEqual([{ uri: row.uri, url: profile.url, username: name, host: 'remote.test' }]);
	const shown = await app.request('/api/notes/show', { method: 'POST', body: JSON.stringify({ i: token, noteId: saved.id }) });
	expect((await shown.json()).text).toBe(saved.text);
	const acquisition = peer.requests.find(r => r.path === `/users/${name}`)!;
	expect(acquisition.signature).toBe(true); expect(acquisition.headers.accept).toContain('application/activity+json');
	expect(peer.discoveries.some(d => d.actor.type === 'Application')).toBe(true);
	expect(profile.description).not.toContain('converted:'); expect(profile.fields[0].value).not.toContain('field:');
});

test.each(['Person', 'Service', 'Group', 'Organization', 'Application'])('actor-create-%s persists source core projection with real database defaults', async type => {
	const fixture = remoteSource.cases.find((c: { id: string; }) => c.id === `actor-create-${type}`);
	const name = `type_${type.toLowerCase()}`;
	register(name, { type, _misskey_summary: undefined, url: undefined, endpoints: undefined });
	expect((await post({ text: `@${name}@remote.test` })).status).toBe(200);
	const row = await remote(name);
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
	const expected = decode(fixture!.expected.events.find((e: { op: string; }) => e.op === 'User.save').args) as Record<string, unknown>;
	for (const key of ['tags', 'isBot', 'isCat', 'requireSigninToViewContents', 'makeNotesFollowersOnlyBefore', 'makeNotesHiddenBefore', 'alsoKnownAs', 'sharedInbox', 'avatarId', 'bannerId', 'emojis']) {
		expect(row[key as keyof MiUser]).toEqual(expected[key]);
	}
	expect(row).toMatchObject({ name: null, isLocked: false, isExplorable: true });
	expect(profile).toMatchObject({ url: null, followingVisibility: 'private', followersVisibility: 'private' });
	expect(await resources.dataSource.getRepository(MiUserPublickey).countBy({ userId: row.id })).toBe(0);
});

test('actor-create-profile-key and actor-refresh-profile-key preserve supported rich scalar fields without tagged conversions', async () => {
	const fixture = remoteSource.cases.find((c: { id: string; }) => c.id === 'actor-create-profile-key');
	const patch = decode(fixture!.input.patch) as Record<string, unknown>;
	// Source fixture's key/URLs identify its remote.test actor; use that actual identity.
	actors.set('/users/a', { ...plainActor(peer.origin, 'a'), ...patch, _misskey_summary: undefined, makeNotesFollowersOnlyBefore: 123, makeNotesHiddenBefore: 456, id: `${peer.origin}/users/a`, preferredUsername: 'Alice', inbox: `${peer.origin}/inbox`, url: `${peer.origin}/@alice`, publicKey: { id: `${peer.origin}/users/a#key`, publicKeyPem: 'test-key-material' }, following: { id: `${peer.origin}/following`, type: 'Collection', items: [] }, followers: { id: `${peer.origin}/followers`, type: 'OrderedCollection', orderedItems: [] } });
	aliases.set('rich', 'a');
	expect((await post({ text: '@rich@remote.test' })).status).toBe(200);
	const row = await remote('alice');
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
	expect(row).toMatchObject({ name: 'N'.repeat(128), isLocked: true, isExplorable: false, isCat: true, tags: ['example'], alsoKnownAs: ['https://alias.test/u'] });
	expect(profile).toMatchObject({ description: 'S'.repeat(2048), birthday: '2000-01-02', location: 'Somewhere', followedMessage: 'hello', fields: [{ name: 'site', value: '**value**' }], followingVisibility: 'public', followersVisibility: 'public' });
	expect(await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id })).toMatchObject({ keyId: `${peer.origin}/users/a#key`, keyPem: 'test-key-material' });
	aliases.set('alice', 'a');
	await stale(row.id);
	actors.set('/users/a', { ...actors.get('/users/a'), preferredUsername: 'Renamed', _misskey_summary: 'refreshed MFM', endpoints: { sharedInbox: `${peer.origin}/inbox/new-rich` } });
	const refreshed = await post({ text: '@alice@remote.test' });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: refreshed.body.createdNote.id })).mentions).toEqual([row.id]);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id })).username).toBe('Alice');
	expect((await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).description).toBe('refreshed MFM');
});

test('failure omission preserves input, mixed recipients, noExtract and authorization before network', async () => {
	const before = peer.requests.length;
	expect((await post({ text: '@never@remote.test' }, null)).status).toBe(401);
	expect((await post({ text: '@never@remote.test', noExtractMentions: true })).status).toBe(200);
	expect(peer.requests.length).toBe(before);
	const result = await post({ text: '@absent@remote.test', cw: '@absent@remote.test', poll: { choices: ['@absent@remote.test', 'b'] }, visibility: 'specified', visibleUserIds: [authorId] });
	expect(result.status).toBe(200);
	const row = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id });
	expect(row).toMatchObject({ text: '@absent@remote.test', cw: '@absent@remote.test', mentions: [authorId], visibleUserIds: [authorId] });
});

test('failed refresh saves attempt first, repairs URI, omits this occurrence, and next lookup is fresh', async () => {
	register('retained'); await post({ text: '@retained@remote.test' });
	const row = await remote('retained'); await stale(row.id);
	aliases.set('retained', 'repaired'); statuses.set('/users/repaired', 503);
	const first = await post({ text: '@retained@remote.test' });
	const saved = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id });
	expect(saved.uri).toBe(`${peer.origin}/users/repaired`); expect(saved.lastFetchedAt!.getTime()).toBeGreaterThan(Date.now() - 10000);
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: first.body.createdNote.id })).mentions).toEqual([]);
	const requests = peer.requests.length;
	const second = await post({ text: '@retained@remote.test' });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: second.body.createdNote.id })).mentions).toEqual([row.id]);
	expect(peer.requests.length).toBe(requests);
});

test('canonical URI duplicate creation races recover one real actor with atomic Profile', async () => {
	register('racing'); aliases.set('racealias', 'racing');
	const results = await Promise.all([post({ text: '@racing@remote.test' }), post({ text: '@racealias@remote.test' })]);
	expect(results.map(r => r.status)).toEqual([200, 200]);
	const row = await remote('racing');
	for (const r of results) {
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: r.body.createdNote.id })).mentions).toEqual([row.id]);
	}
	expect(await resources.dataSource.getRepository(MiUser).countBy({ uri: row.uri! })).toBe(1);
	expect(await resources.dataSource.getRepository(MiUserProfile).countBy({ userId: row.id })).toBe(1);
});

test('actor-create-profile-failure rolls back User and optional Key but permits posting omission', async () => {
	const sourceFailure = profileSource.cases.find(c => c.id === 'create-profile-write')!;
	expect(sourceFailure.expected.events.map((e: any) => e.op)).toContain('transaction.rollback');
	register('rollback', { publicKey: { id: `${peer.origin}/users/rollback#key`, publicKeyPem: 'key' } });
	const restore = await failWrites('user_profile');
	try {
		expect((await post({ text: '@rollback@remote.test' })).status).toBe(200);
	} finally {
		await restore();
	}
	expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: 'rollback', host: 'remote.test' })).toBe(0);
});

test.each(['user_publickey', 'user_profile', 'following'])('refresh partial failure at %s retains earlier commits and prevents later writes', async table => {
	const name = `partial_${table}`;
	if (table === 'user_profile') {
		const sourceFailure = profileSource.cases.find(c => c.id === 'refresh-profile-write')!;
		expect(sourceFailure.expected.events.filter((e: any) => /^(User|Key|Profile)\.update$/.test(e.op)).map((e: any) => e.op)).toEqual(['User.update', 'Key.update', 'Profile.update']);
	}
	register(name, { publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'old' } }); await post({ text: `@${name}@remote.test` });
	const row = await remote(name);
	await resources.dataSource.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: row.id, followeeId: authorId, followerHost: 'remote.test', followerInbox: row.inbox, followerSharedInbox: row.sharedInbox });
	await stale(row.id);
	register(name, { name: 'updated', _misskey_summary: 'new description', endpoints: { sharedInbox: `${peer.origin}/inbox/changed` }, publicKey: { id: `${peer.origin}/users/${name}#key2`, publicKeyPem: 'new' } });
	const restore = await failWrites(table);
	try {
		const r = await post({ text: `@${name}@remote.test` });
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: r.body.createdNote.id })).mentions).toEqual([]);
	} finally {
		await restore();
	}
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id })).name).toBe('updated');
	expect((await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id })).keyPem).toBe(table === 'user_publickey' ? 'old' : 'new');
	expect((await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).description).toBe(table === 'following' ? 'new description' : 'Remote profile');
	expect((await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ followerId: row.id })).followerSharedInbox).toBe(`${peer.origin}/inbox/shared`);
});

test('optional key refresh updates without inserting missing key; deleted rows skip all actor writes; Following updates follower direction only', async () => {
	register('nokey'); await post({ text: '@nokey@remote.test' }); const row = await remote('nokey');
	await resources.dataSource.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: row.id, followeeId: authorId, followerHost: row.host, followerInbox: row.inbox, followerSharedInbox: row.sharedInbox });
	const reverseId = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiFollowing).insert({ id: reverseId, followerId: authorId, followeeId: row.id, followerSharedInbox: 'http://local.test/inbox' });
	await stale(row.id);
	register('nokey', { preferredUsername: 'Renamed', endpoints: { sharedInbox: `${peer.origin}/inbox/new` }, publicKey: { id: `${peer.origin}/users/nokey#key`, publicKeyPem: 'key' } });
	await post({ text: '@nokey@remote.test' });
	expect(await resources.dataSource.getRepository(MiUserPublickey).countBy({ userId: row.id })).toBe(0);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id })).username).toBe('nokey');
	expect((await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ followerId: row.id })).followerSharedInbox).toBe(`${peer.origin}/inbox/new`);
	expect((await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ id: reverseId })).followerSharedInbox).toBe('http://local.test/inbox');
	await resources.dataSource.getRepository(MiUser).update(row.id, { isDeleted: true }); await stale(row.id);
	register('nokey', { name: 'must not update', _misskey_summary: 'must not update' }); await post({ text: '@nokey@remote.test' });
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id })).name).toBeNull();
	expect((await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).description).toBe('Remote profile');
});

test.each([429, 503, 403])('collection %s uses source creation/private and refresh transient preservation asymmetry', async status => {
	const name = `collection_${status}`;
	const path = `/collections/${name}`;
	statuses.set(path, status);
	register(name, { following: `${peer.origin}${path}` }); await post({ text: `@${name}@remote.test` });
	const row = await remote(name);
	const profile = resources.dataSource.getRepository(MiUserProfile);
	expect((await profile.findOneByOrFail({ userId: row.id })).followingVisibility).toBe('private');
	await profile.update({ userId: row.id }, { followingVisibility: 'public' }); await stale(row.id); await post({ text: `@${name}@remote.test` });
	const fixture = remoteSource.cases.find((c: { id: string; }) => c.id === `actor-refresh-collection-${status === 429 ? 'rate-limited' : status === 503 ? 'transient' : 'denied'}`);
	const patch = decode(fixture!.expected.events.find((e: { op: string; }) => e.op === 'Profile.update').args.patch) as { followingVisibility?: string; };
	expect((await profile.findOneByOrFail({ userId: row.id })).followingVisibility).toBe(patch.followingVisibility ?? 'public');
});

test('creation allows foreign Profile URL but refresh rejects it after persisting attempt; bad scheme is omitted', async () => {
	register('foreign', { url: 'https://other.test/profile' }); await post({ text: '@foreign@remote.test' }); const row = await remote('foreign');
	expect((await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).url).toBe('https://other.test/profile');
	await stale(row.id); const result = await post({ text: '@foreign@remote.test' });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([]);
	register('badurl', { url: 'ftp://remote.test/no' }); await post({ text: '@badurl@remote.test' });
	expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: 'badurl', host: 'remote.test' })).toBe(0);
});

test('actors survive the real product mention limit and later Note/Poll insertion failures', async () => {
	const names = Array.from({ length: 21 }, (_, i) => `limit_${i}`); for (const name of names) {
		register(name);
	}
	const result = await post({ text: names.map(n => `@${n}@remote.test`).join(' ') });
	expect(result.status).toBe(400); expect(result.body.error.code).toBe('CONTAINS_TOO_MANY_MENTIONS');
	for (const name of names) {
		expect((await remote(name)).uri).toBe(`${peer.origin}/users/${name}`);
	}
	for (const table of ['note', 'poll']) {
		const name = `survive_${table}`; register(name);
		const before = await resources.dataSource.getRepository(MiNote).count();
		const polls = await resources.dataSource.getRepository(MiPoll).count();
		const restore = await failWrites(table);
		try {
			expect((await post({ text: `@${name}@remote.test`, poll: { choices: ['a', 'b'] } })).status).toBe(500);
		} finally {
			await restore();
		}
		expect((await remote(name)).uri).toBe(`${peer.origin}/users/${name}`);
		expect(await resources.dataSource.getRepository(MiNote).count()).toBe(before);
		expect(await resources.dataSource.getRepository(MiPoll).count()).toBe(polls);
	}
});

test('malformed summary conversion preserves refresh User and Key commits before Profile failure', async () => {
	register('conversion', { publicKey: { id: `${peer.origin}/users/conversion#key`, publicKeyPem: 'old' } });
	await post({ text: '@conversion@remote.test' });
	const row = await remote('conversion'); await stale(row.id);
	register('conversion', { name: 'committed name', _misskey_summary: undefined, summary: '<a href="not-a-url">@bad</a>', publicKey: { id: `${peer.origin}/users/conversion#new`, publicKeyPem: 'new' } });
	const result = await post({ text: '@conversion@remote.test' });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([]);
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id })).name).toBe('committed name');
	expect((await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id })).keyPem).toBe('new');
	expect((await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).description).toBe('Remote profile');
});

test.each([
	{ name: 'badfollowing', patch: { following: { type: 'Collection', items: [] } } },
	{ name: 'badfollowers', patch: { followers: 7 } },
	{ name: 'badshared', patch: { sharedInbox: { type: 'Link', href: 'http://remote.test/inbox' } } },
])('malformed supplied AP ID omits unknown actor $name while preserving text', async ({ name, patch }) => {
	register(name, patch);
	const text = `retain @${name}@remote.test`;
	const result = await post({ text });
	expect(result.status).toBe(200);
	const saved = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id });
	expect(saved).toMatchObject({ text, mentions: [] });
	expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(0);
});

test('malformed sharedInbox refresh preserves actor, key, Profile and Following while saving the attempt', async () => {
	const name = 'retainshared';
	register(name, { name: 'retained name', publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'old key' } });
	await post({ text: `@${name}@remote.test` });
	const row = await remote(name);
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
	const key = await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id });
	const followingId = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiFollowing).insert({ id: followingId, followerId: row.id, followeeId: authorId, followerHost: row.host, followerInbox: row.inbox, followerSharedInbox: row.sharedInbox });
	const following = await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ id: followingId });
	await stale(row.id);
	register(name, { name: 'must not save', inbox: `${peer.origin}/inbox/must-not-save`, sharedInbox: { type: 'Link', href: `${peer.origin}/inbox/new` }, _misskey_summary: 'must not save', publicKey: { id: `${peer.origin}/users/${name}#new`, publicKeyPem: 'must not save' } });
	const text = `retain @${name}@remote.test`;
	const attemptedAt = Date.now();
	const result = await post({ text });
	expect(result.status).toBe(200);
	expect(await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).toMatchObject({ text, mentions: [] });
	const saved = await remote(name);
	expect(saved.lastFetchedAt!.getTime()).toBeGreaterThanOrEqual(attemptedAt);
	expect(saved).toEqual({ ...row, lastFetchedAt: saved.lastFetchedAt });
	expect(await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id })).toEqual(key);
	expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).toEqual(profile);
	expect(await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ id: followingId })).toEqual(following);
});

test('malformed followed-message preserves refresh User and Key commits while retaining Profile and Following', async () => {
	const name = 'followedconversion';
	register(name, { publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'old key' }, _misskey_followedMessage: 'retained message' });
	await post({ text: `@${name}@remote.test` });
	const row = await remote(name);
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
	const followingId = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiFollowing).insert({ id: followingId, followerId: row.id, followeeId: authorId, followerHost: row.host, followerInbox: row.inbox, followerSharedInbox: row.sharedInbox });
	const following = await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ id: followingId });
	await stale(row.id);
	register(name, { name: 'committed name', inbox: `${peer.origin}/inbox/committed`, endpoints: { sharedInbox: `${peer.origin}/inbox/committed-shared` }, _misskey_summary: 'must not save', _misskey_followedMessage: 17, publicKey: { id: `${peer.origin}/users/${name}#new`, publicKeyPem: 'new key' } });
	const text = `retain @${name}@remote.test`;
	const attemptedAt = Date.now();
	const result = await post({ text });
	expect(result.status).toBe(200);
	expect(await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).toMatchObject({ text, mentions: [] });
	const saved = await remote(name);
	expect(saved.lastFetchedAt!.getTime()).toBeGreaterThanOrEqual(attemptedAt);
	expect(saved).toMatchObject({ name: 'committed name', inbox: `${peer.origin}/inbox/committed`, sharedInbox: `${peer.origin}/inbox/committed-shared` });
	expect(await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id })).toMatchObject({ keyId: `${peer.origin}/users/${name}#new`, keyPem: 'new key' });
	expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).toEqual(profile);
	expect(await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ id: followingId })).toEqual(following);
});

test('malformed followed-message creation rolls back the actor before Profile or Key survives', async () => {
	const name = 'badfollowedcreate';
	register(name, { _misskey_followedMessage: 17, publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'new key' } });
	const text = `retain @${name}@remote.test`;
	const before = await resources.dataSource.getRepository(MiUserProfile).count();
	const keys = await resources.dataSource.getRepository(MiUserPublickey).count();
	const result = await post({ text });
	expect(result.status).toBe(200);
	expect(await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).toMatchObject({ text, mentions: [] });
	expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(0);
	expect(await resources.dataSource.getRepository(MiUserProfile).count()).toBe(before);
	expect(await resources.dataSource.getRepository(MiUserPublickey).count()).toBe(keys);
});

test('resolve-cross-host-first-self: unknown account accepts another actor host and first self even with HTML MIME', async () => {
	peer.route('other.test');
	actors.set('/users/cross_target', plainActor('http://other.test', 'cross_target'));
	links.set('crossacct', [{ rel: 'SeLf', type: 'text/html', href: 'http://other.test/users/cross_target' }, { rel: 'self', type: 'application/activity+json', href: 'http://remote.test/ignored' }]);
	const result = await post({ text: '@crossacct@remote.test' });
	const row = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ usernameLower: 'cross_target', host: 'other.test' });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([row.id]);
	expect(row.uri).toBe('http://other.test/users/cross_target');
});

test.each([false, true])('remote self-link to local user with isDeleted=%s retains text and includes only a live target', async isDeleted => {
	const id = codec.newId(Date.now());
	const name = isDeleted ? 'deleted_self_target' : 'live_self_target';
	const account = isDeleted ? 'deletedself' : 'liveself';
	await resources.dataSource.getRepository(MiUser).insert({ id, username: name, usernameLower: name, isDeleted });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: id });
	links.set(account, [{ rel: 'self', href: `http://local.test/users/${id}` }]);
	const text = `retain @${account}@remote.test`;
	const before = peer.requests.length;
	const result = await post({ text });
	expect(result.status).toBe(200);
	const saved = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id });
	expect(saved.text).toBe(text);
	expect(saved.mentions).toEqual(isDeleted ? [] : [id]);
	expect(peer.requests.slice(before)).toHaveLength(1);
	expect(peer.requests[before].path).toContain('/.well-known/webfinger?');
});

test.each([
	{ suffix: '/', isDeleted: false },
	{ suffix: '/inbox', isDeleted: false },
	{ suffix: '/', isDeleted: true },
	{ suffix: '/inbox', isDeleted: true },
])('remote local self-link suffix=$suffix isDeleted=$isDeleted preserves the source live-user resolution', async ({ suffix, isDeleted }) => {
	const id = codec.newId(Date.now());
	const account = `selfrest_${id}`;
	await resources.dataSource.getRepository(MiUser).insert({ id, username: account, usernameLower: account, isDeleted });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: id });
	links.set(account, [{ rel: 'self', href: `http://local.test/users/${id}${suffix}` }]);
	const text = `retain @${account}@remote.test`;
	const before = peer.requests.length;
	const result = await post({ text });
	expect(result.status).toBe(200);
	expect(await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).toMatchObject({ text, mentions: isDeleted ? [] : [id] });
	expect(peer.requests.slice(before)).toHaveLength(1);
	expect(peer.requests[before].path).toContain('/.well-known/webfinger?');
});

test('real PG freshness is inclusive at 24h, stale at one millisecond more, and fresh reads bypass federation-none', async () => {
	register('boundary'); await post({ text: '@boundary@remote.test' }); const row = await remote('boundary');
	const fixed = Date.now();
	await resources.dataSource.getRepository(MiUser).update(row.id, { lastFetchedAt: new Date(fixed - 86400000) });
	clock.mockReturnValue(fixed);
	try {
		const before = peer.requests.length;
		const fresh = await post({ text: '@boundary@remote.test' });
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: fresh.body.createdNote.id })).mentions).toEqual([row.id]);
		expect(peer.requests.length).toBe(before);
		clock.mockReturnValue(fixed + 1);
		await post({ text: '@boundary@remote.test' });
		expect(peer.requests.slice(before).some(r => r.path === '/users/boundary')).toBe(true);
		expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id })).lastFetchedAt?.getTime()).toBe(fixed + 1);
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
		const requests = peer.requests.length;
		const blockedFresh = await post({ text: '@boundary@remote.test @author@local.test' });
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: blockedFresh.body.createdNote.id })).mentions).toEqual([row.id, authorId]);
		expect(peer.requests.length).toBe(requests);
	} finally {
		clock.mockImplementation(realNow); await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	}
});

test('failed stale WebFinger and invalid cross-host repair retain attempt timestamps without inventing stale fallback', async () => {
	for (const kind of ['fingerfail', 'badrepair']) {
		register(kind); await post({ text: `@${kind}@remote.test` }); const row = await remote(kind); await stale(row.id);
		if (kind === 'fingerfail') {
			statuses.set('webfinger:' + kind, 503);
		} else {
			links.set(kind, [{ rel: 'self', href: 'http://other.test/users/repaired' }]);
		}
		const result = await post({ text: `@${kind}@remote.test` });
		const saved = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: row.id });
		expect(saved.uri).toBe(row.uri); expect(saved.lastFetchedAt!.getTime()).toBeGreaterThan(Date.now() - 10000);
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([]);
	}
});

test('Meta.signToActivityPubGet=false uses the real unsigned acquisition path without signer discovery', async () => {
	register('unsigned_meta'); peer.clearKeys();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { signToActivityPubGet: false });
	const discoveries = peer.discoveries.length;
	try {
		const result = await post({ text: '@unsigned_meta@remote.test' });
		const row = await remote('unsigned_meta');
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([row.id]);
		expect(peer.requests.find(r => r.path === '/users/unsigned_meta')).toMatchObject({ signature: null, keyId: null });
		expect(peer.requests.find(r => r.path.includes('resource=acct%3Aunsigned_meta%40remote.test'))?.headers.accept).toBe('application/jrd+json, application/json');
		expect(peer.discoveries.length).toBe(discoveries);
	} finally {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { signToActivityPubGet: true });
	}
});

test('actor creation and refresh attach and detach tags even when the later Note fails', async () => {
	const { MiHashtag } = await import('backend-upstream/entities');
	register('hashtag_later_note', { tag: [{ type: 'Hashtag', name: '#actorfirst' }] });
	const restore = await failWrites('note');
	try {
		expect((await post({ text: '@hashtag_later_note@remote.test' })).status).toBe(500);
	} finally {
		await restore();
	}
	const actor = await remote('hashtag_later_note');
	await resources.userHashtags.idle();
	expect(await resources.dataSource.getRepository(MiHashtag).findOneBy({ name: 'actorfirst' })).toMatchObject({ attachedUserIds: [actor.id], attachedUsersCount: 1, attachedRemoteUserIds: [actor.id], attachedRemoteUsersCount: 1, mentionedUserIds: [] });
	await stale(actor.id);
	register('hashtag_later_note', { tag: [{ type: 'Hashtag', name: '#Ａ' }, { type: 'Hashtag', name: '#a' }] });
	expect((await post({ text: '@hashtag_later_note@remote.test' })).status).toBe(200);
	await resources.userHashtags.idle();
	expect((await remote('hashtag_later_note')).tags).toEqual(['a', 'a']);
	expect(await resources.dataSource.getRepository(MiHashtag).findOneBy({ name: 'a' })).toMatchObject({ attachedUserIds: [actor.id], attachedUsersCount: 1, attachedRemoteUsersCount: 1 });
	expect(await resources.dataSource.getRepository(MiHashtag).findOneBy({ name: 'actorfirst' })).toMatchObject({ attachedUserIds: [], attachedUsersCount: 0, attachedRemoteUserIds: [], attachedRemoteUsersCount: 0 });
});

test('duplicate canonical actor preserves stored tags while new actor tags replace attached membership', async () => {
	const { MiHashtag } = await import('backend-upstream/entities');
	register('hashtag_canonical', { tag: [{ type: 'Hashtag', name: '#canonicalold' }] });
	expect((await post({ text: '@hashtag_canonical@remote.test' })).status).toBe(200);
	await resources.userHashtags.idle();
	const canonical = await remote('hashtag_canonical');
	aliases.set('hashtag_alias', 'hashtag_canonical');
	register('hashtag_canonical', { tag: [{ type: 'Hashtag', name: '#canonicalnew' }] });
	const response = await post({ text: '@hashtag_alias@remote.test' });
	expect(response.status).toBe(200);
	await resources.userHashtags.idle();
	expect((await remote('hashtag_canonical')).tags).toEqual(['canonicalold']);
	expect(await resources.dataSource.getRepository(MiHashtag).findOneBy({ name: 'canonicalold' })).toMatchObject({ attachedUserIds: [], attachedUsersCount: 0 });
	expect(await resources.dataSource.getRepository(MiHashtag).findOneBy({ name: 'canonicalnew' })).toMatchObject({ attachedUserIds: [canonical.id], attachedUsersCount: 1 });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: response.body.createdNote.id })).mentions).toEqual([canonical.id]);
});

test('hashtag DB failure preserves already started Redis ranking and stops later tags', async () => {
	const { MiHashtag } = await import('backend-upstream/entities');
	const db = resources.dataSource;
	await db.query('CREATE FUNCTION usertag_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = \'failattached\' THEN RAISE EXCEPTION \'attached failure\'; END IF; RETURN NEW; END $$');
	await db.query('CREATE TRIGGER usertag_fail BEFORE INSERT ON hashtag FOR EACH ROW EXECUTE FUNCTION usertag_fail()');
	try {
		register('hashtag_dbfail', { tag: [{ type: 'Hashtag', name: '#failattached' }, { type: 'Hashtag', name: '#afterfailattached' }] });
		expect((await post({ text: '@hashtag_dbfail@remote.test' })).status).toBe(200);
		await resources.userHashtags.idle();
		const actor = await remote('hashtag_dbfail');
		expect(await resources.redis.smembers('hashtagUsers:failattached')).toEqual([actor.id]);
		expect(await db.getRepository(MiHashtag).findOneBy({ name: 'failattached' })).toBeNull();
		expect(await db.getRepository(MiHashtag).findOneBy({ name: 'afterfailattached' })).toBeNull();
		expect(await resources.redis.exists('hashtagUsers:afterfailattached')).toBe(0);
	} finally {
		await db.query('DROP TRIGGER usertag_fail ON hashtag'); await db.query('DROP FUNCTION usertag_fail()');
	}
});

test('Redis command failure is diagnosed while the actor DB sequence completes', async () => {
	const logStart = hashtagLogs.length;
	const { MiHashtag } = await import('backend-upstream/entities');
	const original = resources.redis.sismember.bind(resources.redis);
	const failure = vi.spyOn(resources.redis, 'sismember').mockImplementation((...args) => args[0] === 'hashtagUsers:redisattachedfail' ? Promise.reject(Error('injected Redis command failure')) : original(...args));
	try {
		register('hashtag_redisfail', { tag: [{ type: 'Hashtag', name: '#redisattachedfail' }, { type: 'Hashtag', name: '#afterredisattached' }] });
		expect((await post({ text: '@hashtag_redisfail@remote.test' })).status).toBe(200);
		await resources.userHashtags.idle();
		const actor = await remote('hashtag_redisfail');
		for (const name of ['redisattachedfail', 'afterredisattached']) {
			expect(await resources.dataSource.getRepository(MiHashtag).findOneBy({ name })).toMatchObject({ attachedUserIds: [actor.id], attachedUsersCount: 1 });
		}
		expect(await resources.redis.smembers('hashtagUsers:afterredisattached')).toEqual([actor.id]);
		expect(hashtagLogs.slice(logStart).some(line => line.includes('user-hashtags.failed') && line.includes(actor.id))).toBe(true);
	} finally {
		failure.mockRestore();
	}
});

async function instanceCount() {
	await resources.actorInstanceRegistration.idle();
	return (await resources.dataSource.getRepository(MiInstance).findOneBy({ host: 'remote.test' }))?.usersCount ?? 0;
}

test('real public actor/profile/key commit increments instance once; fresh and stale-refresh lookups do not increment; raw increment leaves registration cache stale', async () => {
	await resources.actorInstanceRegistration.idle();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	// Isolate raw increment cache behavior: concurrent metadata legitimately refreshes the whole row.
	await resources.redis.set('fetchInstanceMetadata:mutex:v2:remote.test', '1', 'EX', 30);
	const before = await instanceCount();
	register('instancecount', { publicKey: { id: `${peer.origin}/users/instancecount#key`, publicKeyPem: 'instance-key' } });
	const result = await post({ text: '@instancecount@remote.test', localOnly: true });
	expect(result.status).toBe(200);
	const row = await remote('instancecount');
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([row.id]);
	expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).toMatchObject({ userHost: 'remote.test', description: 'Remote profile' });
	expect(await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id })).toMatchObject({ keyPem: 'instance-key' });
	expect(await instanceCount()).toBe(before + 1);
	const key = 'kvcache:federatedInstance:remote.test';
	const cached = await resources.redis.get(key);
	expect(cached).not.toBeNull();
	expect(JSON.parse(cached!).usersCount).toBeLessThan(before + 1);
	await post({ text: '@instancecount@remote.test fresh', localOnly: true });
	await stale(row.id); await post({ text: '@instancecount@remote.test refresh', localOnly: true });
	expect(await instanceCount()).toBe(before + 1);
	expect(await resources.redis.get(key)).toBe(cached);
	await resources.redis.del('fetchInstanceMetadata:mutex:v2:remote.test');
});

test.each([true, false])('two public unknown aliases force canonical duplicate recovery and stats=%s counts each committed/recovered acquisition', async enabled => {
	await resources.actorInstanceRegistration.idle();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: enabled });
	const before = await instanceCount();
	const name = enabled ? 'instance_race_on' : 'instance_race_off';
	register(name, { publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'race-key' } }); aliases.set(name + '_alias', name);
	actorBarrier = { paths: new Set([`/users/${name}`]), count: 0, entered: deferred(), release: deferred() };
	const barrier = actorBarrier;
	try {
		const pending = Promise.all([post({ text: `@${name}@remote.test`, localOnly: true }), post({ text: `@${name}_alias@remote.test`, localOnly: true })]);
		await barrier.entered.promise; barrier.release.resolve();
		const results = await pending;
		expect(results.map(result => result.status)).toEqual([200, 200]);
		const row = await remote(name);
		for (const result of results) {
			expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([row.id]);
		}
		expect(await resources.dataSource.getRepository(MiUser).countBy({ uri: row.uri! })).toBe(1);
		expect(await resources.dataSource.getRepository(MiUserProfile).countBy({ userId: row.id })).toBe(1);
		expect(await resources.dataSource.getRepository(MiUserPublickey).countBy({ userId: row.id })).toBe(1);
		expect(await instanceCount()).toBe(before + (enabled ? 2 : 0));
	} finally {
		barrier.release.resolve(); actorBarrier = null;
	}
});

test('disabled normal creation and rolled-back Profile/Key never change usersCount', async () => {
	await resources.actorInstanceRegistration.idle();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: false });
	const before = await instanceCount();
	register('instance_disabled'); expect((await post({ text: '@instance_disabled@remote.test', localOnly: true })).status).toBe(200);
	expect(await instanceCount()).toBe(before);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	for (const table of ['user_profile', 'user_publickey']) {
		const name = `instance_rollback_${table}`; register(name, { publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'key' } });
		const restore = await failWrites(table);
		try {
			const result = await post({ text: `@${name}@remote.test`, localOnly: true }); expect(result.status).toBe(200); expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([]);
		} finally {
			await restore();
		}
		expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(0);
		expect(await instanceCount()).toBe(before);
	}
});

test('increment failure is diagnostic and does not undo real HTTP actor/key or posting; later Note failure leaves actor and increment committed', async () => {
	await resources.actorInstanceRegistration.idle();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	const before = await instanceCount(); const logBefore = hashtagLogs.length;
	register('instance_increment_failure', { publicKey: { id: `${peer.origin}/users/instance_increment_failure#key`, publicKeyPem: 'key' } });
	const restore = await failWrites('instance');
	try {
		const result = await post({ text: '@instance_increment_failure@remote.test', localOnly: true }); expect(result.status).toBe(200);
		const row = await remote('instance_increment_failure');
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([row.id]);
		expect(await resources.dataSource.getRepository(MiUserPublickey).countBy({ userId: row.id })).toBe(1);
		await resources.actorInstanceRegistration.idle();
		expect(hashtagLogs.slice(logBefore).map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'actor-instance-registration.failed', stage: 'increment', host: 'remote.test' }));
	} finally {
		await restore();
	}
	expect(await instanceCount()).toBe(before);
	register('instance_note_failure'); const restoreNote = await failWrites('note');
	try {
		expect((await post({ text: '@instance_note_failure@remote.test', localOnly: true })).status).toBe(500);
	} finally {
		await restoreNote();
	}
	expect(await remote('instance_note_failure')).toMatchObject({ host: 'remote.test' });
	expect(await instanceCount()).toBe(before + 1);
	expect(await resources.dataSource.getRepository(MiNote).countBy({ text: '@instance_note_failure@remote.test' })).toBe(0);
});

test('two real HTTP actors concurrently first-register one host, and parallel direct increments preserve cache without lost updates', async () => {
	await resources.actorInstanceRegistration.idle();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableStatsForFederatedInstances: true });
	const host = 'instance-first.test'; peer.route(host);
	await resources.redis.set(`fetchInstanceMetadata:mutex:v2:${host}`, '1', 'EX', 30);
	for (const name of ['instance_first_a', 'instance_first_b']) {
		register(name, { id: `http://${host}/users/${name}`, inbox: `http://${host}/inbox/${name}`, endpoints: { sharedInbox: `http://${host}/inbox/shared` }, publicKey: { id: `http://${host}/users/${name}#key`, publicKeyPem: 'key' } });
		links.set(name, [{ rel: 'self', href: `http://${host}/users/${name}` }]);
	}
	const barrier = { paths: new Set(['/users/instance_first_a', '/users/instance_first_b']), count: 0, entered: deferred(), release: deferred() }; actorBarrier = barrier;
	try {
		const pending = Promise.all(['instance_first_a', 'instance_first_b'].map(name => post({ text: `@${name}@${host}`, localOnly: true })));
		await barrier.entered.promise; barrier.release.resolve(); expect((await pending).map(r => r.status)).toEqual([200, 200]);
		await resources.actorInstanceRegistration.idle();
		const repository = resources.dataSource.getRepository(MiInstance);
		expect(await repository.countBy({ host })).toBe(1);
		expect(await repository.findOneByOrFail({ host })).toMatchObject({ usersCount: 2 });
		const cacheKey = `kvcache:federatedInstance:${host}`;
		const cached = await resources.redis.get(cacheKey); expect(cached).not.toBeNull(); expect(JSON.parse(cached!).usersCount).toBeLessThan(2);
		for (let i = 0; i < 16; i++) {
			resources.actorInstanceRegistration.start(host);
		}
		await resources.actorInstanceRegistration.idle();
		expect(await repository.findOneByOrFail({ host })).toMatchObject({ usersCount: 18 });
		expect(await resources.redis.get(cacheKey)).toBe(cached);
	} finally {
		barrier.release.resolve(); actorBarrier = null;
		await resources.redis.del(`fetchInstanceMetadata:mutex:v2:${host}`);
	}
});

function emojiTag(name: string, url = `https://remote.test/${name}.png`, patch: Record<string, unknown> = {}) {
	return { type: 'Emoji', name: `:${name}:`, id: `https://remote.test/emoji/${name}`, updated: '2026-01-01', icon: { url }, ...patch };
}

test('public actor emoji create/fresh/stale writes reach packed remote author URLs without image acquisition', async () => {
	const tag = emojiTag('emojiflow');
	register('emojiflow', { tag: [tag] });
	expect((await post({ text: '@emojiflow@remote.test', localOnly: true })).status).toBe(200);
	const actor = await remote('emojiflow');
	expect(actor.emojis).toEqual(['emojiflow']);
	const repository = resources.dataSource.getRepository(MiEmoji);
	const row = await repository.findOneByOrFail({ host: 'remote.test', name: 'emojiflow' });
	expect(row).toMatchObject({ uri: tag.id, originalUrl: tag.icon.url, publicUrl: tag.icon.url, aliases: [], license: null, category: null, type: null, localOnly: false, isSensitive: false });
	const fetched = peer.requests.filter(r => r.path === '/users/emojiflow').length;
	register('emojiflow', { tag: [emojiTag('emojiflow', 'https://remote.test/new.png')] });
	await post({ text: '@emojiflow@remote.test fresh', localOnly: true });
	expect(peer.requests.filter(r => r.path === '/users/emojiflow')).toHaveLength(fetched);
	expect((await repository.findOneByOrFail({ id: row.id })).publicUrl).toBe(tag.icon.url);
	await stale(actor.id);
	await post({ text: '@emojiflow@remote.test stale', localOnly: true });
	expect((await repository.findOneByOrFail({ id: row.id })).publicUrl).toBe('https://remote.test/new.png');
	const noteId = codec.newId(Date.now());
	// A fixture remote-author Note checks existing packing; no remote Note reception is claimed.
	await resources.dataSource.getRepository(MiNote).insert({ id: noteId, userId: actor.id, userHost: actor.host, text: ':emojiflow:', visibility: 'public' });
	const shown = await app.request('/api/notes/show', { method: 'POST', body: JSON.stringify({ i: token, noteId }) });
	expect(shown.status).toBe(200);
	expect((await shown.json()).user.emojis).toEqual({ emojiflow: 'https://remote.test/new.png' });
	expect(peer.requests.some(r => r.path.endsWith('.png'))).toBe(false);
});

test('canonical duplicate retains stored User names while independently storing newly fetched emoji', async () => {
	register('emojicanon', { tag: [emojiTag('canon_old')] });
	await post({ text: '@emojicanon@remote.test', localOnly: true });
	const canonical = await remote('emojicanon');
	aliases.set('emojialias', 'emojicanon');
	register('emojicanon', { tag: [emojiTag('canon_new')] });
	const result = await post({ text: '@emojialias@remote.test', localOnly: true });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([canonical.id]);
	expect((await remote('emojicanon')).emojis).toEqual(['canon_old']);
	expect(await resources.dataSource.getRepository(MiEmoji).findOneBy({ host: 'remote.test', name: 'canon_new' })).not.toBeNull();
});

test.each(['actor', 'note'])('emoji writes survive later %s rollback through public posting', async stage => {
	const name = `emojirollback_${stage}`;
	register(name, { tag: [emojiTag(name)] });
	const restore = await failWrites(stage === 'actor' ? 'user_profile' : 'note');
	try {
		expect((await post({ text: `@${name}@remote.test`, localOnly: true })).status).toBe(stage === 'actor' ? 200 : 500);
	} finally {
		await restore();
	}
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name })).toBe(1);
	expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(stage === 'actor' ? 0 : 1);
});

test.each([false, true])('URL failure preserves source emoji side-effect boundary (refresh=%s)', async refresh => {
	const name = `emojiurl_${refresh}`;
	if (refresh) {
		register(name); await post({ text: `@${name}@remote.test`, localOnly: true }); await stale((await remote(name)).id);
	}
	register(name, { url: 'ftp://remote.test/invalid', tag: [emojiTag(name)] });
	const result = await post({ text: `@${name}@remote.test rejected`, localOnly: true });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([]);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name })).toBe(refresh ? 1 : 0);
});

test('duplicate new tags use one snapshot, fail unique constraint, retain one emoji and save empty User names', async () => {
	register('emojidupe', { tag: [emojiTag('dupe_new'), emojiTag('dupe_new')] });
	expect((await post({ text: '@emojidupe@remote.test', localOnly: true })).status).toBe(200);
	await resources.remoteEmojis.idle();
	expect((await remote('emojidupe')).emojis).toEqual([]);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name: 'dupe_new' })).toBe(1);
	// A later actor sees the persisted snapshot and retains duplicate names, without another insert.
	register('emojidupe_existing', { tag: [emojiTag('dupe_new'), emojiTag('dupe_new')] });
	await post({ text: '@emojidupe_existing@remote.test', localOnly: true });
	expect((await remote('emojidupe_existing')).emojis).toEqual(['dupe_new', 'dupe_new']);
});

test('per-tag DB failure leaves independent successful writes and clears refresh names', async () => {
	register('emojipartial', { tag: [emojiTag('partial_old')] }); await post({ text: '@emojipartial@remote.test', localOnly: true });
	await stale((await remote('emojipartial')).id);
	register('emojipartial', { tag: [emojiTag('partial_good'), emojiTag('partial_bad', 'https://remote.test/' + 'x'.repeat(600))] });
	expect((await post({ text: '@emojipartial@remote.test', localOnly: true })).status).toBe(200);
	await resources.remoteEmojis.idle();
	expect((await remote('emojipartial')).emojis).toEqual([]);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name: 'partial_good' })).toBe(1);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name: 'partial_bad' })).toBe(0);
});

test('inserted emoji survives insert-refetch failure while actor proceeds with empty names', async () => {
	register('emojirefetch', { tag: [emojiTag('insert_refetch')] });
	const refetch = vi.spyOn(resources.dataSource.getRepository(MiEmoji), 'findOneOrFail').mockRejectedValueOnce(Error('injected insert refetch failure'));
	try {
		expect((await post({ text: '@emojirefetch@remote.test', localOnly: true })).status).toBe(200);
	} finally {
		refetch.mockRestore();
	}
	expect((await remote('emojirefetch')).emojis).toEqual([]);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name: 'insert_refetch' })).toBe(1);
});

test('emoji query failure is caught independently from actor transaction errors', async () => {
	register('emojiqueryfail', { tag: [emojiTag('query_failure')] });
	const query = vi.spyOn(resources.dataSource.getRepository(MiEmoji), 'findBy').mockRejectedValueOnce(Error('injected emoji query failure'));
	try {
		expect((await post({ text: '@emojiqueryfail@remote.test', localOnly: true })).status).toBe(200);
	} finally {
		query.mockRestore();
	}
	expect((await remote('emojiqueryfail')).emojis).toEqual([]);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name: 'query_failure' })).toBe(0);
});

test.each([undefined, null])('updating a remote emoji preserves undefined URI and clears explicit null (%s)', async uri => {
	const name = uri === null ? 'emojiurinull' : 'emojiuriabsent';
	register(name, { tag: [emojiTag(name)] }); await post({ text: `@${name}@remote.test`, localOnly: true });
	await stale((await remote(name)).id);
	register(name, { tag: [emojiTag(name, 'https://remote.test/changed.png', { id: uri })] });
	await post({ text: `@${name}@remote.test`, localOnly: true });
	expect((await resources.dataSource.getRepository(MiEmoji).findOneByOrFail({ host: 'remote.test', name })).uri).toBe(uri === null ? null : `https://remote.test/emoji/${name}`);
});

test('concurrent public actor acquisitions share an empty emoji snapshot and preserve the actual unique-conflict result', async () => {
	const repository = resources.dataSource.getRepository(MiEmoji);
	const find = repository.findBy.bind(repository);
	const snapshots = deferred<void>(); let readers = 0;
	const query = vi.spyOn(repository, 'findBy').mockImplementation(async criteria => {
		const rows = await find(criteria);
		if (!Array.isArray(criteria) && criteria.host === 'remote.test') {
			readers++;
			if (readers === 2) {
				snapshots.resolve();
			}
			await snapshots.promise;
		}
		return rows;
	});
	for (const name of ['emojicompetitor_a', 'emojicompetitor_b']) {
		register(name, { tag: [emojiTag('competing_shared')] });
	}
	try {
		const results = await Promise.all(['emojicompetitor_a', 'emojicompetitor_b'].map(name => post({ text: `@${name}@remote.test`, localOnly: true })));
		expect(results.map(result => result.status)).toEqual([200, 200]);
	} finally {
		query.mockRestore();
	}
	await resources.remoteEmojis.idle();
	expect(readers).toBe(2);
	expect(await repository.countBy({ host: 'remote.test', name: 'competing_shared' })).toBe(1);
	const names = await Promise.all(['emojicompetitor_a', 'emojicompetitor_b'].map(async name => (await remote(name)).emojis));
	expect(names.filter(value => value.length === 0)).toHaveLength(1);
	expect(names.filter(value => value[0] === 'competing_shared')).toHaveLength(1);
});

test('deleted refresh guard skips User changes after independent emoji extraction has committed', async () => {
	register('emojideleted', { tag: [emojiTag('deleted_old')] });
	await post({ text: '@emojideleted@remote.test', localOnly: true });
	const actor = await remote('emojideleted');
	await resources.dataSource.getRepository(MiUser).update(actor.id, { isDeleted: true });
	await stale(actor.id);
	register('emojideleted', { name: 'must not replace', tag: [emojiTag('deleted_new')] });
	expect((await post({ text: '@emojideleted@remote.test after deletion', localOnly: true })).status).toBe(200);
	expect(await resources.dataSource.getRepository(MiEmoji).countBy({ host: 'remote.test', name: 'deleted_new' })).toBe(1);
	expect(await resources.dataSource.getRepository(MiUser).findOneBy({ id: actor.id })).toMatchObject({ isDeleted: true, name: actor.name, emojis: ['deleted_old'] });
});

const profileSource = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/remote-user/remote-profile-observations.json', import.meta.url), 'utf8')) as { sourceStorage: { descriptionMaxCharacters: number }; cases: { id: string; area: string; input: any; expected: any }[] };

// Each successful source profile is persisted through real token HTTP, remote HTTP,
// and PostgreSQL, on both initial creation and the existing stale-refresh caller.
test.each(profileSource.cases.filter(c => ['create', 'refresh'].includes(c.area) && !c.expected.error && c.id !== 'create-canonical'))('$id source conversion meets actual public HTTP/PG storage boundary', async fixture => {
	const name = 'profile_' + fixture.id.replaceAll('-', '_');
	const refresh = fixture.area === 'refresh';
	if (refresh) {
		register(name);
		expect((await post({ text: `@${name}@remote.test` })).status).toBe(200);
		await stale((await remote(name)).id);
	}
	const before = refresh ? await remote(name) : null;
	const beforeProfile = before ? await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: before.id }) : null;
	register(name, { _misskey_summary: undefined, ...(decode(fixture.input) as { patch?: Record<string, unknown> }).patch });
	const result = await post({ text: `retain @${name}@remote.test` });
	expect(result.status, JSON.stringify(result.body)).toBe(200);
	const expected = fixture.expected.events.find((e: any) => e.op === (refresh ? 'Profile.update' : 'Profile.save')).args;
	// Real PG varchar enforces source schema length. The source trace's repository
	// double records a successful conversion even when this actual write must fail.
	const oversized = Array.from(expected.description ?? '').length > profileSource.sourceStorage.descriptionMaxCharacters;
	const note = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id });
	if (oversized) {
		expect(note.mentions).toEqual([]);
		if (before) {
			expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: before.id })).toEqual(beforeProfile);
		} else {
			expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(0);
		}
	} else {
		const row = await remote(name);
		expect(note.mentions).toEqual([row.id]);
		expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).toMatchObject({ description: expected.description, fields: expected.fields });
	}
});

test.each(profileSource.cases.filter(c => /^(create|refresh)-(attachment-priority|attachment-conversion|bad-summary)$/.test(c.id)))('$id source failure preserves actual HTTP/PG write boundary', async fixture => {
	const name = 'profile_' + fixture.id.replaceAll('-', '_');
	const refresh = fixture.area === 'refresh';
	let beforeUser: MiUser | undefined;
	let beforeProfile: MiUserProfile | undefined;
	let beforeKey: MiUserPublickey | undefined;
	let beforeFollowing: MiFollowing | undefined;
	if (refresh) {
		register(name, { publicKey: { id: `${peer.origin}/users/${name}#old`, publicKeyPem: 'old' } });
		expect((await post({ text: `@${name}@remote.test` })).status).toBe(200);
		const row = await remote(name);
		beforeProfile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
		beforeKey = await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: row.id });
		await resources.dataSource.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: row.id, followeeId: authorId, followerHost: row.host, followerInbox: row.inbox, followerSharedInbox: row.sharedInbox });
		beforeFollowing = await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ followerId: row.id });
		await stale(row.id); beforeUser = await remote(name);
	}
	const profiles = await resources.dataSource.getRepository(MiUserProfile).count();
	const keys = await resources.dataSource.getRepository(MiUserPublickey).count();
	register(name, { _misskey_summary: undefined, ...(decode(fixture.input) as { patch?: Record<string, unknown> }).patch, name: 'new source profile', publicKey: { id: `${peer.origin}/users/${name}#new`, publicKeyPem: 'new' } });
	const text = `retain @${name}@remote.test`;
	const attemptedAt = Date.now();
	const result = await post({ text });
	expect(result.status).toBe(200);
	expect(await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).toMatchObject({ text, mentions: [] });
	if (!refresh) {
		expect(await resources.dataSource.getRepository(MiUser).countBy({ usernameLower: name, host: 'remote.test' })).toBe(0);
		expect(await resources.dataSource.getRepository(MiUserProfile).count()).toBe(profiles);
		expect(await resources.dataSource.getRepository(MiUserPublickey).count()).toBe(keys);
	} else {
		const saved = await remote(name);
		expect(saved.lastFetchedAt!.getTime()).toBeGreaterThanOrEqual(attemptedAt);
		expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: saved.id })).toEqual(beforeProfile);
		expect(await resources.dataSource.getRepository(MiFollowing).findOneByOrFail({ followerId: saved.id })).toEqual(beforeFollowing);
		const sourceWrites = fixture.expected.events.map((e: any) => e.op);
		if (sourceWrites.includes('User.update')) {
			expect(saved.name).toBe('new source profile');
			expect((await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: saved.id })).keyPem).toBe('new');
		} else {
			expect(saved).toEqual({ ...beforeUser, lastFetchedAt: saved.lastFetchedAt });
			expect(await resources.dataSource.getRepository(MiUserPublickey).findOneByOrFail({ userId: saved.id })).toEqual(beforeKey);
		}
	}
});

test('create-canonical source fallback preserves the already persisted Profile on public alias acquisition', async () => {
	const fixture = profileSource.cases.find(c => c.id === 'create-canonical')!;
	const name = 'profile_canonical';
	register(name, { _misskey_summary: 'retained canonical profile' });
	expect((await post({ text: `@${name}@remote.test` })).status).toBe(200);
	const row = await remote(name);
	const profile = await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id });
	aliases.set('profile_alias', name);
	register(name, { _misskey_summary: undefined, ...(decode(fixture.input) as { patch?: Record<string, unknown> }).patch });
	const result = await post({ text: '@profile_alias@remote.test' });
	expect(result.status).toBe(200);
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([row.id]);
	expect(fixture.expected.events.filter((e: any) => e.op === 'Profile.save')).toEqual([]);
	expect(await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: row.id })).toEqual(profile);
});

async function seedActorImages(name: string) {
	register(name, { tag: [{ type: 'Hashtag', name: '#imageold' }], publicKey: { id: `${peer.origin}/users/${name}#key`, publicKeyPem: 'retained-image-key' } });
	expect((await post({ text: `@${name}@remote.test` })).status).toBe(200);
	await resources.userHashtags.idle();
	const db = resources.dataSource;
	const user = await remote(name);
	const avatarId = codec.newId(Date.now());
	const bannerId = codec.newId(Date.now());
	for (const id of [avatarId, bannerId]) {
		await db.getRepository(MiDriveFile).insert({ id, userId: user.id, md5: '0'.repeat(32), name: 'retained.png', type: 'image/png', size: 1, storedInternal: false, url: `https://media.test/${id}`, properties: {} });
	}
	const images = { avatarId, avatarUrl: 'https://media.test/old-avatar', avatarBlurhash: 'old-avatar-hash', bannerId, bannerUrl: 'https://media.test/old-banner', bannerBlurhash: 'old-banner-hash' };
	await db.getRepository(MiUser).update(user.id, images);
	const profile = await db.getRepository(MiUserProfile).findOneByOrFail({ userId: user.id });
	const key = await db.getRepository(MiUserPublickey).findOneByOrFail({ userId: user.id });
	const files = await db.getRepository(MiDriveFile).findBy({ userId: user.id });
	return { user, images, profile, key, files };
}

const clearedActorImages = { avatarId: null, avatarUrl: null, avatarBlurhash: null, bannerId: null, bannerUrl: null, bannerBlurhash: null };

// Catches the consequential canonical repair and the public consumer of old avatar fields.
test('canonical alias recovery clears all six images, repacks existing author and retains relations', async () => {
	const name = 'image_canonical';
	const seeded = await seedActorImages(name);
	const db = resources.dataSource;
	const noteId = codec.newId(Date.now());
	await db.getRepository(MiNote).insert({ id: noteId, userId: seeded.user.id, userHost: 'remote.test', text: 'existing remote author', visibility: 'public' });
	const show = async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, noteId }) });
		expect(response.status).toBe(200);
		return response.json();
	};
	expect((await show()).user).toMatchObject({ avatarUrl: seeded.images.avatarUrl, avatarBlurhash: seeded.images.avatarBlurhash });
	aliases.set('image_alias', name);
	register(name, { icon: [null, { url: '' }], image: {}, tag: [{ type: 'Hashtag', name: '#imagenew' }], summary: 'must not overwrite canonical Profile', publicKey: { id: `${peer.origin}/new-key`, publicKeyPem: 'must not overwrite' } });
	const result = await post({ text: '@image_alias@remote.test' });
	expect(result.status).toBe(200);
	await resources.userHashtags.idle();
	expect(await db.getRepository(MiUser).findOneByOrFail({ id: seeded.user.id })).toMatchObject({ ...clearedActorImages, tags: ['imageold'] });
	expect((await db.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([seeded.user.id]);
	expect(await db.getRepository(MiUserProfile).findOneByOrFail({ userId: seeded.user.id })).toEqual(seeded.profile);
	expect(await db.getRepository(MiUserPublickey).findOneByOrFail({ userId: seeded.user.id })).toEqual(seeded.key);
	expect(await db.getRepository(MiDriveFile).findBy({ userId: seeded.user.id })).toEqual(seeded.files);
	const shown = await show();
	expect(shown.user.avatarUrl).not.toBe(seeded.images.avatarUrl);
	expect(shown.user.avatarBlurhash).toBeNull();
});

test('isolated BEFORE UPDATE image failure retains old fields and canonical mention while INSERT and other actor updates work', async () => {
	const name = 'image_failure';
	const seeded = await seedActorImages(name);
	const db = resources.dataSource;
	await db.query(`CREATE FUNCTION image_clear_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${seeded.user.id}' AND NEW."avatarId" IS NULL AND NEW."avatarUrl" IS NULL AND NEW."avatarBlurhash" IS NULL AND NEW."bannerId" IS NULL AND NEW."bannerUrl" IS NULL AND NEW."bannerBlurhash" IS NULL THEN RAISE EXCEPTION 'isolated image clear failure'; END IF; RETURN NEW; END $$`);
	await db.query('CREATE TRIGGER image_clear_fail BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION image_clear_fail()');
	const logStart = hashtagLogs.length;
	try {
		register('image_other');
		expect((await post({ text: '@image_other@remote.test' })).status).toBe(200);
		const other = await remote('image_other');
		await db.getRepository(MiUser).update(other.id, { name: 'other write works' });
		expect((await remote('image_other')).name).toBe('other write works');
		aliases.set('image_failure_alias', name);
		register(name, { icon: null, image: null });
		const result = await post({ text: '@image_failure_alias@remote.test' });
		expect(result.status).toBe(200);
		expect((await db.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([seeded.user.id]);
		expect(await remote(name)).toMatchObject({ ...seeded.images, tags: seeded.user.tags });
		expect(await db.getRepository(MiUserProfile).findOneByOrFail({ userId: seeded.user.id })).toEqual(seeded.profile);
		expect(await db.getRepository(MiUserPublickey).findOneByOrFail({ userId: seeded.user.id })).toEqual(seeded.key);
		expect(await db.getRepository(MiDriveFile).findBy({ userId: seeded.user.id })).toEqual(seeded.files);
		expect(hashtagLogs.slice(logStart).filter(line => line.includes('remote-actor.image-update-failed') && line.includes(seeded.user.id))).toHaveLength(1);
	} finally {
		await db.query('DROP TRIGGER image_clear_fail ON "user"');
		await db.query('DROP FUNCTION image_clear_fail()');
	}
});

test.each([
	{ icon: { url: 'https://media.test/present' }, image: null },
	{ icon: null, image: { url: 'https://media.test/present' } },
	{ icon: { url: '' }, image: null },
	{ icon: 'https://media.test/string', image: null },
])('canonical mixed-image exclusion preserves six fields for %j', async patch => {
	const name = `image_mixed_${codec.newId(Date.now()).toLowerCase()}`;
	const seeded = await seedActorImages(name);
	const alias = `${name}_alias`;
	aliases.set(alias, name);
	register(name, patch);
	const result = await post({ text: `@${alias}@remote.test` });
	expect(result.status).toBe(200);
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([seeded.user.id]);
	expect(await remote(name)).toMatchObject(seeded.images);
});

test('normal both-absent creation persists six null fields and canonical mention', async () => {
	register('image_new', { icon: [], image: { url: null } });
	const result = await post({ text: '@image_new@remote.test' });
	expect(result.status).toBe(200);
	const user = await remote('image_new');
	expect(user).toMatchObject(clearedActorImages);
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([user.id]);
});

test('canonical recovery clears images by ID even for a deleted canonical actor', async () => {
	const seeded = await seedActorImages('image_deleted');
	await resources.dataSource.getRepository(MiUser).update(seeded.user.id, { isDeleted: true });
	aliases.set('image_deleted_alias', 'image_deleted');
	register('image_deleted', { icon: null, image: null });
	const result = await post({ text: '@image_deleted_alias@remote.test' });
	expect(result.status).toBe(200);
	expect(await remote('image_deleted')).toMatchObject({ ...clearedActorImages, isDeleted: true });
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: result.body.createdNote.id })).mentions).toEqual([seeded.user.id]);
});
