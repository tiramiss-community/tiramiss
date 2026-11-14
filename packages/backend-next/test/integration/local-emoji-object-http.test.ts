/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiEmoji, MiMeta } from 'backend-upstream/entities';
import corpus from '../../../../docs/superpowers/compatibility/remote-user/local-emoji-object-corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/remote-user/local-emoji-object-observations.json' with { type: 'json' };
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let port: number;
const request = (path = '/emojis/hello', method = 'GET', accept = 'application/activity+json') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Accept: accept }, redirect: 'manual' });
const repository = () => resources.dataSource.getRepository(MiEmoji);
const expected = (id: string) => observations.cases.find(row => row.id === id)!.expected;

async function seed(extra: QueryDeepPartialEntity<MiEmoji> = {}) {
	await repository().insert({ ...corpus.defaults.emoji, updatedAt: new Date(corpus.defaults.emoji.updatedAt), ...extra });
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = corpus.defaults.selfUrl;
	resources = await connectResources(database.config, createLogger('local-emoji-object-test', () => {}));
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	port = (server.address() as { port: number }).port;
});
beforeEach(async () => {
	await repository().deleteAll();
	await resources.dataSource.getRepository(MiMeta).deleteAll();
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

test('ordinary listening HTTP publishes the fixed-source Emoji and leaves stored state unchanged', async () => {
	await seed();
	const before = await repository().find();
	const meta = await resources.dataSource.getRepository(MiMeta).find();
	const queries: string[] = [];
	const capture = vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation(query => {
 queries.push(query); 
});
	try {
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expected('public').body);
		for (const [name, value] of Object.entries(expected('public').headers)) {
			expect(response.headers.get(name), name).toBe(value);
		}
		expect(queries.some(query => /FROM "emoji"/.test(query) && /"host" IS NULL/.test(query) && /"name" =/.test(query))).toBe(true);
		expect(queries.filter(query => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(query))).toEqual([]);
	} finally {
		capture.mockRestore();
	}
	expect(await repository().find()).toEqual(before);
	expect(await resources.dataSource.getRepository(MiMeta).find()).toEqual(meta);
});

test.each([
	['missing', null], ['remote', { host: 'remote.test' }], ['localOnly', { localOnly: true }],
] as const)('%s yields empty uncached404 without redirect or persistence changes', async (_kind, row) => {
	if (row) {
		await seed(row);
	}
	const before = await repository().find();
	const response = await request();
	expect(response.status).toBe(404);
	expect(await response.text()).toBe('');
	expect(response.headers.get('cache-control')).toBeNull();
	expect(response.headers.get('location')).toBeNull();
	expect(response.headers.get('vary')).toBeNull();
	expect(response.headers.get('access-control-allow-origin')).toBe('*');
	expect(await repository().find()).toEqual(before);
});

test('exact local name wins over a remote homonym; aliases and case folding do not select rows', async () => {
	await seed({ aliases: ['alias'] });
	await seed({ id: 'remote', host: 'remote.test', publicUrl: 'https://remote.test/image' });
	const response = await request();
	expect(await response.json()).toEqual(expected('public').body);
	for (const path of ['/emojis/HELLO', '/emojis/alias', '/emojis/hello@remote.test']) {
		expect((await request(path)).status).toBe(404);
	}
});

test('each request reads current saved values and does not install an Emoji value cache', async () => {
	await seed();
	expect((await request()).status).toBe(200);
	await repository().update('emoji', { publicUrl: 'https://media.test/new', localOnly: false, isSensitive: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] });
	const published = await request();
	expect(published.status).toBe(200);
	expect(await published.json()).toMatchObject({ icon: { url: 'https://media.test/new' } });
	await repository().update('emoji', { localOnly: true });
	expect((await request()).status).toBe(404);
	await repository().delete('emoji');
	expect((await request()).status).toBe(404);
});

test('stored null/empty fallbacks and undated clock are rendered without writes', async () => {
	await seed({ type: null, publicUrl: '', license: null, updatedAt: null });
	const before = await repository().find();
	const start = Date.now();
	const response = await request();
	const body = await response.json() as { updated: string };
	const end = Date.now();
	expect(body).toMatchObject({ icon: { mediaType: 'image/png', url: corpus.defaults.emoji.originalUrl }, _misskey_license: { freeText: null } });
	expect(Date.parse(body.updated)).toBeGreaterThanOrEqual(start);
	expect(Date.parse(body.updated)).toBeLessThanOrEqual(end);
	expect(await repository().find()).toEqual(before);
	await repository().update('emoji', { type: '', license: '' });
	expect(await (await request()).json()).toMatchObject({ icon: { mediaType: '' }, _misskey_license: { freeText: '' } });
});

test('federation none gates before Emoji lookup and errors; specified remains public', async () => {
	await seed();
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
	const queries: string[] = [];
	const capture = vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation(query => {
 queries.push(query); 
});
	try {
		for (const method of ['GET', 'HEAD']) {
			const response = await request('/emojis/hello', method);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe('');
			expect(response.headers.get('cache-control')).toBeNull();
		}
		expect(queries.some(query => /FROM "emoji"/.test(query))).toBe(false);
	} finally {
		capture.mockRestore();
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'specified' });
	expect((await request()).status).toBe(200);
});

test.each(['GET', 'HEAD'])('%s chooses LD only when selected, preserves public cache and omits Vary', async method => {
	await seed();
	for (const accept of ['text/html', 'application/json', 'application/activity+json;q=0', 'application/ld+json']) {
		const response = await request('/emojis/hello?page=true', method, accept);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=180');
		expect(response.headers.get('vary')).toBeNull();
		expect(response.headers.get('content-type')).toBe(expected(accept === 'application/ld+json' ? 'accept-ld' : 'public').headers['content-type']);
		if (method === 'HEAD') {
			expect(await response.text()).toBe('');
		} else {
			expect(await response.json()).toEqual(expected('public').body);
		}
	}
});

test('OPTIONS bypasses Meta and Emoji reads; malformed paths reject before CORS and federation', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
	const queries: string[] = [];
	const capture = vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation(query => {
 queries.push(query); 
});
	try {
		const options = await request('/emojis/hello', 'OPTIONS');
		expect(options.status).toBe(404);
		expect(options.headers.get('access-control-allow-origin')).toBeNull();
		for (const path of ['/emojis/%ZZ', '/emojis/%C0%AF', `/emojis/${'x'.repeat(101)}`]) {
			for (const method of ['GET', 'HEAD']) {
				const response = await request(path, method);
				expect(response.status).toBe(path.endsWith('x') ? 414 : 400);
				expect(response.headers.get('access-control-allow-origin')).toBeNull();
				if (method === 'HEAD') {
					expect(await response.text()).toBe('');
				}
			}
		}
		expect(queries).toEqual([]);
	} finally {
		capture.mockRestore();
	}
});

test.each(['', '猫', 'a/b', '%68ello', 'a+b', 'x'.repeat(100), '😀'.repeat(50)])('saved path name %s is decoded once and returned unescaped in object id', async name => {
	await seed({ name });
	const response = await request(`/emojis/${encodeURIComponent(name)}`);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ id: `${corpus.defaults.selfUrl}/emojis/${name}`, name: `:${name}:` });
});

test('real Emoji relation failure yields uncached500 and leaves rows intact after restoration', async () => {
	await seed();
	const before = await repository().find();
	await resources.dataSource.query('ALTER TABLE "emoji" RENAME TO "emoji_unavailable"');
	try {
		for (const method of ['GET', 'HEAD']) {
			const response = await request('/emojis/hello', method);
			expect(response.status).toBe(500);
			expect(response.headers.get('cache-control')).toBeNull();
			expect(response.headers.get('access-control-allow-origin')).toBe('*');
			if (method === 'GET') {
				expect(await response.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
			} else {
				expect(await response.text()).toBe('');
			}
		}
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
		expect((await request()).status).toBe(403);
	} finally {
		await resources.dataSource.query('ALTER TABLE "emoji_unavailable" RENAME TO "emoji"');
	}
	expect(await repository().find()).toEqual(before);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	expect((await request()).status).toBe(200);
});
