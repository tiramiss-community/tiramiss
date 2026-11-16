/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Redis } from 'ioredis';
import { createActorEmojiCache } from '../../src/platform/actor-emoji-cache.js';
import { MiEmoji, MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import corpus from '../../../../docs/superpowers/compatibility/public-emojis/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/public-emojis/observations.json' with { type: 'json' };
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('public-emojis-test', () => {}));
	await resources.dataSource.getRepository(MiEmoji).insert(corpus.rows);
	await resources.dataSource.getRepository(MiUser).insert({ id: 'viewer', username: 'viewer', usernameLower: 'viewer', token: 'validtoken123456' });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

for (const observation of observations.cases) {
	test(`listening API matches pinned PostgreSQL/source observation: ${observation.id}`, async () => {
		const item = corpus.cases.find(item => item.id === observation.id)!;
		const response = await fetch(url + item.path, {
			method: item.method,
			headers: { ...('body' in item ? { 'Content-Type': 'application/json' } : {}), ...('headers' in item ? item.headers : {}) },
			...('body' in item ? { body: JSON.stringify(item.body) } : {}),
		});
		expect(response.status).toBe(observation.status);
		expect(response.headers.get('cache-control')).toBe(observation.cacheControl);
		expect(response.headers.get('content-type')).toBe(observation.contentType);
		const text = await response.text();
		const body = text ? JSON.parse(text) : null;
		if (body?.error?.info?.e) {
			delete body.error.info.e.id;
			delete body.error.info.e.message;
		}
		expect(body).toEqual(observation.body);
	});
}

test('public reads bypass warm local caches and fail on unavailable DB while local and remote cache hits survive', async () => {
	const repository = resources.dataSource.getRepository(MiEmoji);
	await resources.actorEmojis.local(['plain']);
	await resources.actorEmojis.remote([{ emojis: ['remote', 'missing'], host: 'remote.test' }], 'example.test');
	await repository.update('plain', { publicUrl: 'https://changed.test/plain' });
	const fresh = await fetch(url + '/api/emoji?name=plain');
	expect((await fresh.json()).url).toBe('https://changed.test/plain');
	expect((await resources.actorEmojis.local(['plain']))[0].publicUrl).toBe('');
	await resources.dataSource.query('ALTER TABLE "emoji" RENAME TO "emoji_unavailable"');
	try {
		const unavailable = await fetch(url + '/api/emojis');
		expect(unavailable.status).toBe(500);
		expect(unavailable.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
		expect((await unavailable.json()).error.code).toBe('INTERNAL_ERROR');
		expect((await resources.actorEmojis.local(['plain']))[0].originalUrl).toBe('https://original.test/plain');
		expect(await resources.actorEmojis.remote([{ emojis: ['remote', 'missing'], host: 'remote.test' }], 'example.test')).toEqual(new Map([['remote@remote.test', 'https://remote.test/emoji']]));
	} finally {
		await resources.dataSource.query('ALTER TABLE "emoji_unavailable" RENAME TO "emoji"');
	}
	await repository.delete('plain');
	expect((await fetch(url + '/api/emoji?name=plain')).status).toBe(500);
	expect((await resources.actorEmojis.local(['plain']))).toHaveLength(1);
});

test('existing collection cache retains negative results after insert, unlike source explicit prefetch', async () => {
	expect(observations.prefetch[1].urls).toContainEqual(['missing remote.test', 'https://new.test/missing']);
	await resources.actorEmojis.remote([{ emojis: ['newmissing'], host: 'remote.test' }], 'example.test');
	await resources.dataSource.getRepository(MiEmoji).insert({ id: 'newmissing', name: 'newmissing', host: 'remote.test', publicUrl: 'https://new.test/missing', originalUrl: '' });
	expect(await resources.actorEmojis.remote([{ emojis: ['newmissing'], host: 'remote.test' }], 'example.test')).toEqual(new Map());
});

test('real disconnected Redis fails expired local reads while memory hits and public DB reads remain independent', async () => {
	const redis = new Redis({ ...database.config.redis, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0, enableOfflineQueue: false });
	redis.on('error', () => {});
	let now = 0;
	const cache = createActorEmojiCache(resources.dataSource.manager, redis, () => now);
	try {
		await redis.connect();
		expect(await cache.local(['restricted'])).toHaveLength(1);
		await new Promise<void>(resolve => {
			redis.once('end', resolve);
			redis.disconnect();
		});
		expect(await cache.local(['restricted'])).toHaveLength(1);
		now = 180001;
		await expect(cache.local(['restricted'])).rejects.toThrow();
		expect((await fetch(url + '/api/emoji?name=restricted')).status).toBe(200);
	} finally {
		await cache.close();
		redis.disconnect();
	}
	await expect(cache.local(['restricted'])).rejects.toThrow('closed');
});
