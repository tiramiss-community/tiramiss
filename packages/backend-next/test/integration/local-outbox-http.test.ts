/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiMeta, MiNote, MiUser } from 'backend-upstream/entities';
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
let timeline: Redis;
let server: Server;
let port: number;
const key = (replies = false) => `list:userTimeline${replies ? 'WithReplies' : ''}:alice`;
const id = (n: number) => `at3hjq77n${String(n).padStart(6, '0')}`;
const request = (path: string, method = 'GET', accept = 'application/activity+json') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Accept: accept }, redirect: 'manual' });
interface Page { id: string; totalItems: number; prev?: string; next?: string; orderedItems: { id: string; type: string; object: { id: string; inReplyTo?: string } | string; '@context'?: unknown }[] }
const page = async (suffix = '') => {
	const response = await request(`/users/alice/outbox?page=true${suffix}`);
	expect(response.status).toBe(200);
	return await response.json() as Page;
};
const numbers = (page: Page) => page.orderedItems.map(item => Number(item.id.split('/').at(-2)!.slice(-6)));

async function seed(count: number, extra: QueryDeepPartialEntity<MiNote> = {}) {
	if (count) {
		await resources.dataSource.getRepository(MiNote).insert(Array.from({ length: count }, (_, i) => ({ id: id(i + 1), userId: 'alice', visibility: 'public' as const, text: `note ${i + 1}`, ...extra })));
	}
}

async function caches(ordinary: string[] = [], replies: string[] = []) {
	await timeline.del(key(), key(true));
	if (ordinary.length) {
		await timeline.rpush(key(), ...ordinary);
	}
	if (replies.length) {
		await timeline.rpush(key(true), ...replies);
	}
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = 'https://local.example';
	database.config.redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-outbox`, keyPrefix: `${database.config.redis.prefix}-outbox:` };
	resources = await connectResources(database.config, createLogger('local-outbox-test', () => { }));
	timeline = new Redis(database.config.redisForTimelines);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	port = (server.address() as { port: number }).port;
});
beforeEach(async () => {
	await resources.notePostSave.idle();
	await resources.notePostDelete.idle();
	await resources.dataSource.query('TRUNCATE TABLE "user" CASCADE');
	await resources.dataSource.getRepository(MiMeta).deleteAll();
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all', enableFanoutTimeline: false, enableFanoutTimelineDbFallback: false, ugcVisibilityForVisitor: 'all' });
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: 'alice', username: 'alice', usernameLower: 'alice', token: 'outboxalice00000', notesCount: 123 },
		{ id: 'bob', username: 'bob', usernameLower: 'bob', token: 'outboxbob0000000' },
		{ id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test' },
	]);
	await caches();
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	timeline?.disconnect();
	await resources?.close();
	await database?.close();
});
test.each([0, 1, 20, 21, 45])('DB page with %i rows uses stored count, twenty limit and nearest-newer reversal', async count => {
	await seed(count);
	const result = await page();
	expect(result.totalItems).toBe(123);
	expect(numbers(result)).toEqual(Array.from({ length: Math.min(count, 20) }, (_, i) => count - i));
	if (count) {
		expect(result.prev).toBe(`https://local.example/users/alice/outbox?page=true&since_id=${id(count)}`);
		expect(result.next).toBe(`https://local.example/users/alice/outbox?page=true&until_id=${id(Math.max(1, count - 19))}`);
	} else {
		expect(result).not.toHaveProperty('prev');
		expect(result).not.toHaveProperty('next');
	}
	const since = await page(`&since_id=${id(2)}`);
	expect(numbers(since)).toEqual(Array.from({ length: Math.min(Math.max(0, count - 2), 20) }, (_, i) => Math.min(count, 22) - i));
	const until = await page(`&until_id=${id(2)}`);
	expect(numbers(until)).toEqual(count > 0 ? [1] : []);
	const empty = await page('&since_id=');
	expect(numbers(empty)).toEqual(numbers(result));
	expect(empty.id).toBe('https://local.example/users/alice/outbox?page=true&since_id=');
});
test('index uses actor stored count and fixed-zero last without reading Note/cache or writing DB', async () => {
	await seed(2);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true });
	await timeline.set(key(), 'WRONGTYPE');
	const queries: string[] = [];
	const capture = vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation(query => {
		queries.push(query);
	});
	try {
		const response = await request('/users/alice/outbox');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ totalItems: 123, first: 'https://local.example/users/alice/outbox?page=true', last: 'https://local.example/users/alice/outbox?page=true&since_id=000000000000000000000000' });
		expect(queries.some(q => /FROM "note"/.test(q))).toBe(false);
		expect(queries.filter(q => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(q))).toEqual([]);
	} finally {
		capture.mockRestore();
	}
});
test('local root predicate and local user lookup preserve remote/missing/visibility/localOnly distinctions', async () => {
	await seed(1);
	for (const path of ['/users/remote/outbox', '/users/missing/outbox', '/notes/missing/activity']) {
		expect((await request(path)).status).toBe(404);
	}
	for (const extra of [{ visibility: 'home' as const }, { visibility: 'followers' as const }, { visibility: 'specified' as const }, { localOnly: true }, { userHost: 'remote.test', uri: 'https://remote.test/note' }]) {
		await resources.dataSource.getRepository(MiNote).update(id(1), { visibility: 'public', localOnly: false, userHost: null, uri: null, ...extra });
		const response = await request(`/notes/${id(1)}/activity`);
		expect(response.status).toBe(extra.visibility === 'home' ? 200 : 404);
		expect(response.headers.get('location')).toBeNull();
	}
});
test('DB-only pages and activity permit suspended authors and ignore cache-only visitor/blocked-related checks', async () => {
	await seed(2);
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	await resources.dataSource.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'none', blockedHosts: ['remote.test'] });
	expect(numbers(await page())).toEqual([2, 1]);
	expect((await request(`/notes/${id(1)}/activity`)).status).toBe(200);
});
test('publication Create/Announce are bare in collection; missing pure target fails but missing quote is tolerated', async () => {
	await seed(1);
	await resources.dataSource.getRepository(MiNote).insert([{ id: id(2), userId: 'alice', renoteId: id(1), visibility: 'home' }, { id: id(3), userId: 'alice', visibility: 'public', renoteId: id(1), text: '' }]);
	let result = await page();
	expect(result.orderedItems.map(item => item.type)).toEqual(['Create', 'Announce', 'Create']);
	for (const item of result.orderedItems) {
		expect(item).not.toHaveProperty('@context');
		if (typeof item.object === 'object') {
			expect(item.object).not.toHaveProperty('@context');
		}
	}
	expect(result.orderedItems[1].object).toBe(`https://local.example/notes/${id(1)}`);
	await resources.dataSource.getRepository(MiNote).delete(id(1));
	// Source Note relations deliberately have no FK constraint, so deleted target IDs remain stored.
	const missing = await request(`/notes/${id(2)}/activity`);
	expect(missing.status).toBe(500);
	expect(missing.headers.get('cache-control')).toBe('public, max-age=180');
	expect((await request('/users/alice/outbox?page=true')).status).toBe(500);
	const quote = await request(`/notes/${id(3)}/activity`);
	expect(quote.status).toBe(200);
	expect(await quote.json()).toMatchObject({ type: 'Create', object: { type: 'Note' } });
	await resources.dataSource.getRepository(MiNote).delete(id(2));
	result = await page();
	expect(result.orderedItems).toHaveLength(1);
});
test.each(['GET', 'HEAD'])('%s headers, negotiation, explicit errors and empty paths use source HTTP metadata', async method => {
	await seed(1);
	for (const path of ['/users/alice/outbox', '/users/alice/outbox?page=true', `/notes/${id(1)}/activity`]) {
		const response = await request(path, method, 'application/ld+json');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe(path.includes('page=true') ? null : 'public, max-age=180');
		expect(response.headers.get('vary')).toBe(path.includes('/notes/') ? 'Accept' : null);
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		if (method === 'HEAD') {
			expect(await response.text()).toBe('');
		}
	}
	for (const path of ['/users//outbox', '/notes//activity']) {
		const response = await request(path, method);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
	}
	for (const path of ['/users/%ZZ/outbox', `/notes/${'x'.repeat(101)}/activity`]) {
		const response = await request(path, method);
		expect(response.status).toBe(path.includes('%ZZ') ? 400 : 414);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	}
});
test('duplicate/empty query validation precedes missing user, federation takes precedence, OPTIONS avoids CORS', async () => {
	for (const suffix of ['?since_id=&until_id=', '?since_id=x&since_id=x', '?until_id=&until_id=x']) {
		expect((await request(`/users/missing/outbox${suffix}`)).status).toBe(400);
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
	for (const path of ['/users/missing/outbox?since_id=&until_id=', '/notes/missing/activity']) {
		expect((await request(path)).status).toBe(403);
		const options = await request(path, 'OPTIONS');
		expect(options.status).toBe(404);
		expect(options.headers.get('access-control-allow-origin')).toBeNull();
	}
	for (const path of [`/notes/${'x'.repeat(101)}/activity`, `/users/${'x'.repeat(101)}/outbox`]) {
		const response = await request(path, 'OPTIONS');
		expect(response.status).toBe(404);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	}
});
test('real Redis merges duplicates and replies and rehydrates missing/stale/private IDs before returning twenty', async () => {
	await seed(50);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true });
	await resources.dataSource.getRepository(MiNote).update(id(49), { visibility: 'followers' });
	await resources.dataSource.getRepository(MiNote).update(id(48), { localOnly: true });
	await resources.dataSource.getRepository(MiNote).update(id(47), { replyId: id(1), replyUserId: 'alice' });
	await resources.dataSource.getRepository(MiNote).delete(id(46));
	const ids = Array.from({ length: 50 }, (_, i) => id(i + 1));
	await caches([id(99), ...ids], [id(47), id(99), ...ids.slice(20)]);
	expect(numbers(await page())).toEqual([50, 47, ...Array.from({ length: 18 }, (_, i) => 45 - i)]);
	expect(await resources.redis.lrange(key(), 0, -1)).toEqual([]);
});
test('more than twenty rejected candidates refill, then partial fallback starts after last consumed stale ID', async () => {
	await seed(70);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true, enableFanoutTimelineDbFallback: false });
	for (let n = 40; n <= 69; n++) {
		await resources.dataSource.getRepository(MiNote).update(id(n), { localOnly: true });
	}
	await resources.dataSource.getRepository(MiNote).delete(id(39));
	await caches(Array.from({ length: 32 }, (_, i) => id(70 - i)));
	// cache survivors: 70. Fallback after examined missing 39, filling nineteen strictly older public Notes.
	expect(numbers(await page())).toEqual([70, ...Array.from({ length: 19 }, (_, i) => 38 - i)]);
});
test('since coverage forces nearest twenty DB fallback even with cache-only visitor rejection and disabled config fallback', async () => {
	await seed(45);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true, enableFanoutTimelineDbFallback: false, ugcVisibilityForVisitor: 'none' });
	await caches(Array.from({ length: 30 }, (_, i) => id(45 - i)));
	expect(numbers(await page(`&since_id=${id(2)}`))).toEqual(Array.from({ length: 20 }, (_, i) => 22 - i));
	expect(numbers(await page('&since_id='))).toEqual(Array.from({ length: 20 }, (_, i) => 45 - i));
});
test.each(['suspended-author', 'suspended-reply', 'suspended-renote', 'blocked-reply', 'blocked-renote', 'visitor-none'] as const)('cache-only %s filtering differs from fallback without filtering fallback rows again', async mode => {
	await seed(25);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true, blockedHosts: ['blocked.test'] });
	await resources.dataSource.getRepository(MiNote).insert({ id: id(100), userId: 'bob', userHost: 'blocked.test', visibility: 'public', text: 'related' });
	if (mode === 'suspended-author') {
		await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	}
	if (mode.startsWith('suspended-') && mode !== 'suspended-author') {
		await resources.dataSource.getRepository(MiUser).update('bob', { isSuspended: true });
	}
	if (mode.endsWith('reply')) {
		await resources.dataSource.getRepository(MiNote).update(id(25), { replyId: id(100), replyUserId: 'bob', replyUserHost: mode.startsWith('blocked-') ? 'sub.blocked.test' : null });
	}
	if (mode.endsWith('renote')) {
		await resources.dataSource.getRepository(MiNote).update(id(25), { renoteId: id(100), renoteUserId: 'bob', renoteUserHost: mode.startsWith('blocked-') ? 'blocked.test' : null });
	}
	if (mode === 'visitor-none') {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'none' });
	}
	await caches([id(25)]);
	expect(numbers(await page())).toEqual(Array.from({ length: 20 }, (_, i) => 24 - i));
	await caches();
	// Empty cache directly falls back and includes the same row that the cache path rejected.
	expect(numbers(await page())).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
});
test('WRONGTYPE returns 500 and cannot trigger DB fallback even when fallback would succeed', async () => {
	await seed(3);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true });
	await timeline.set(key(), 'WRONGTYPE');
	const queries: string[] = [];
	const capture = vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation(query => {
		queries.push(query);
	});
	try {
		const response = await request('/users/alice/outbox?page=true');
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBeNull();
		expect(await response.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
		expect(queries.some(q => /FROM "note"/.test(q))).toBe(false);
	} finally {
		capture.mockRestore();
	}
});
test('existing listening ordinary/reply posting producer feeds both timelines; GETs write no DB DML', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true });
	const post = async (input: object, token = 'outboxalice00000') => {
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, text: 'producer', ...input }) });
		expect(response.status).toBe(200);
		const body = await response.json() as { createdNote: { id: string } };
		await resources.notePostSave.idle();
		return body.createdNote.id;
	};
	const ordinary = await post({});
	const target = await post({}, 'outboxbob0000000');
	const reply = await post({ replyId: target });
	expect(await timeline.lrange(key(), 0, -1)).toContain(ordinary);
	expect(await timeline.lrange(key(true), 0, -1)).toContain(reply);
	expect(await resources.redis.lrange(key(true), 0, -1)).toEqual([]);
	// Meta exists; posting (including key/cache setup and its asynchronous side effects) is idle before measurement.
	// No exemption is needed inside this finite GET window: every INSERT/UPDATE/DELETE is counted.
	const queries: string[] = [];
	const capture = vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation(query => {
		queries.push(query);
	});
	try {
		const result = await page();
		expect(result.orderedItems.map(item => item.id)).toEqual([reply, ordinary].sort().reverse().map(noteId => `https://local.example/notes/${noteId}/activity`));
		expect(result.orderedItems.find(item => item.id.includes(reply))!.object).toMatchObject({ inReplyTo: `https://local.example/notes/${target}` });
		for (const noteId of [ordinary, reply]) {
			expect((await request(`/notes/${noteId}/activity`)).status).toBe(200);
		}
		expect(queries.filter(q => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(q))).toEqual([]);
		expect(queries.some(q => /FROM "note"/.test(q))).toBe(true);
	} finally {
		capture.mockRestore();
	}
	const deletion = await fetch(`http://127.0.0.1:${port}/api/notes/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: 'outboxalice00000', noteId: reply }) });
	expect(deletion.status).toBe(204);
	await resources.notePostDelete.idle();
	expect(await timeline.lrange(key(true), 0, -1)).toContain(reply);
	expect((await page()).orderedItems.map(item => item.id)).toEqual([`https://local.example/notes/${ordinary}/activity`]);
});
