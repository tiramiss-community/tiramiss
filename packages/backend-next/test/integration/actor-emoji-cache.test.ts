/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiEmoji, MiMeta, MiNote, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createActorEmojiCache } from '../../src/platform/actor-emoji-cache.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server, url: string, now = 1000;
let cache: ReturnType<typeof createActorEmojiCache>;
const local = 'emojilocal', remote = 'emojiremote';
let noteId: string;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('emoji-cache-test', () => {}));
	await resources.actorEmojis.close();
	cache = createActorEmojiCache(resources.dataSource.manager, resources.redis, () => now);
	resources.actorEmojis = cache;
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'z', federation: 'all', ugcVisibilityForVisitor: 'all', enableStatsForFederatedInstances: false });
	await resources.dataSource.getRepository(MiUser).insert([{ id: local, username: 'alice', usernameLower: 'alice', emojis: ['wave', 'wave', 'private'] }, { id: remote, username: 'bob', usernameLower: 'bob', host: 'remote.test', uri: 'https://remote.test/bob', emojis: ['remote', 'missing', 'empty'] }]);
	await resources.dataSource.getRepository(MiUserProfile).insert([{ userId: local }, { userId: remote }]);
	const key = await generateRsaKeyPair();
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: local, publicKey: key.publicKeyPem, privateKey: key.privateKeyPem });
	await resources.dataSource.getRepository(MiEmoji).insert([
		{ id: 'localemoji', name: 'wave', host: null, publicUrl: 'https://old.test/local', originalUrl: 'https://original.test/local', updatedAt: new Date(1000) },
		{ id: 'privateemoji', name: 'private', host: null, publicUrl: 'https://private.test/local', originalUrl: 'https://private.test/local', localOnly: true },
		{ id: 'emptyemoji', name: 'empty', host: 'remote.test', publicUrl: '', originalUrl: '' },
		{ id: 'remoteemoji', name: 'remote', host: 'remote.test', publicUrl: 'https://old.test/remote', originalUrl: 'https://old.test/remote', updatedAt: new Date(1000) },
	]);
	noteId = createIdCodec('aidx').newId(Date.now());
	await resources.dataSource.getRepository(MiNote).insert({ id: noteId, userId: remote, userHost: 'remote.test', text: 'remote actor cache fixture', visibility: 'public' });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} await cache?.close(); await resources?.close(); await database?.close();
});
const actor = async () => {
	const r = await fetch(`${url}/users/${local}`, { headers: { Accept: 'application/activity+json' } }); expect(r.status).toBe(200); return r.json();
};
const author = async () => {
	const r = await fetch(`${url}/api/notes/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId }) }); expect(r.status).toBe(200); return (await r.json()).user.emojis;
};

test('ordinary actor HTTP uses memory and Redis snapshots while the emoji table is unavailable', async () => {
	expect((await actor()).tag.map((tag: any) => tag.icon.url)).toEqual(['https://old.test/local', 'https://old.test/local']);
	const key = 'singlecache:localEmojis';
	expect(await resources.redis.ttl(key)).toBeGreaterThan(1790);
	expect(await resources.redis.ttl(key)).toBeLessThanOrEqual(1800);
	await resources.dataSource.query('ALTER TABLE "emoji" RENAME TO "emoji_unavailable"');
	try {
		expect((await actor()).tag[0].updated).toBe('1970-01-01T00:00:01.000Z');
		now += 180001;
		expect((await actor()).tag[0].updated).toBe('1970-01-01T00:00:01.000Z');
	} finally {
		await resources.dataSource.query('ALTER TABLE "emoji_unavailable" RENAME TO "emoji"');
	}
	await resources.dataSource.getRepository(MiEmoji).update('localemoji', { publicUrl: 'https://new.test/local' });
	expect((await actor()).tag[0].icon.url).toBe('https://old.test/local');
	await resources.redis.pexpire(key, 1);
	await new Promise(resolve => setTimeout(resolve, 5));
	now += 180001;
	expect((await actor()).tag[0].icon.url).toBe('https://new.test/local');
	await resources.dataSource.getRepository(MiEmoji).delete('localemoji');
	await resources.redis.del(key); now += 180001;
	expect((await actor()).tag).toEqual([]);
});

test('packed remote actor URL hits survive DB unavailability and actor extraction does not invalidate positive or negative entries', async () => {
	expect(await author()).toEqual({ remote: 'https://old.test/remote', empty: '' });
	await resources.dataSource.query('ALTER TABLE "emoji" RENAME TO "emoji_unavailable"');
	try {
		expect(await author()).toEqual({ remote: 'https://old.test/remote', empty: '' });
	} finally {
		await resources.dataSource.query('ALTER TABLE "emoji_unavailable" RENAME TO "emoji"');
	}
	await resources.remoteEmojis.extract([
		{ type: 'Emoji', name: ':remote:', icon: { url: 'https://new.test/remote' } },
		{ type: 'Emoji', name: ':missing:', icon: { url: 'https://new.test/missing' } },
	], 'remote.test');
	expect((await resources.dataSource.getRepository(MiEmoji).findOneByOrFail({ host: 'remote.test', name: 'remote' })).publicUrl).toBe('https://new.test/remote');
	expect(await author()).toEqual({ remote: 'https://old.test/remote', empty: '' });
	now += 43200001;
	expect(await author()).toEqual({ remote: 'https://new.test/remote', missing: 'https://new.test/missing', empty: '' });
	await resources.dataSource.getRepository(MiEmoji).delete({ host: 'remote.test' });
	expect(await author()).toEqual({ remote: 'https://new.test/remote', missing: 'https://new.test/missing', empty: '' });
	now += 43200001;
	expect(await author()).toEqual({});
});
