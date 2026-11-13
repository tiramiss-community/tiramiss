/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiFollowing, MiMeta, MiUser, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { followCorpus, followSource } from '../helpers/local-follow-collections.js';
import type { Server } from 'node:http';
import type { FollowCollectionCase } from '../helpers/local-follow-collections.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let port: number;

const request = (path: string, method = 'GET', accept: string | null = 'application/activity+json') => fetch(`http://127.0.0.1:${port}${path}`, {
	method, headers: accept === null ? {} : { Accept: accept }, redirect: 'manual',
});

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = followCorpus.defaults.selfUrl;
	resources = await connectResources(database.config, createLogger('local-follow-collections-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).deleteAll();
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	port = (server.address() as { port: number }).port;
});

afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

async function seed(c: FollowCollectionCase) {
	const manager = resources.dataSource.manager;
	// Test-only reset, including FK children; no product CRUD uses raw SQL.
	await manager.query('TRUNCATE TABLE "user" CASCADE');
	await manager.getRepository(MiMeta).deleteAll();
	await manager.getRepository(MiMeta).insert({ id: 'singleton', federation: c.federation === 'none' ? 'none' : 'all' });
	const size = c.size ?? followCorpus.defaults.size;
	await manager.getRepository(MiUser).insert({ id: 'alice', username: 'alice', usernameLower: 'alice', host: c.ownerHost ?? null, followersCount: 123, followingCount: 456, isSuspended: c.suspended ?? false });
	if (!c.missingProfile) {
		await manager.getRepository(MiUserProfile).insert({
			userId: 'alice',
			followersVisibility: (c.direction === 'followers' ? c.visibility : c.otherVisibility) as 'public' | 'private' | 'followers' | undefined,
			followingVisibility: (c.direction === 'following' ? c.visibility : c.otherVisibility) as 'public' | 'private' | 'followers' | undefined,
		});
	}
	if (size > 0) {
		await manager.getRepository(MiUser).insert(Array.from({ length: size }, (_, i) => {
			const id = `u${String(i + 1).padStart(3, '0')}`;
			return { id, username: id, usernameLower: id, host: (i + 1) % 2 ? 'remote.test' : null, uri: c.nullMember ? null : `https://remote.test/${id}` };
		}));
		await manager.getRepository(MiFollowing).insert(Array.from({ length: size }, (_, i) => {
			const n = String(i + 1).padStart(3, '0');
			return { id: `r${n}`, followerId: c.direction === 'followers' ? `u${n}` : 'alice', followeeId: c.direction === 'following' ? `u${n}` : 'alice' };
		}));
	}
	if (c.missing) {
		await manager.getRepository(MiUser).delete('alice');
	}
}

async function snapshot() {
	const manager = resources.dataSource.manager;
	return {
		users: await manager.getRepository(MiUser).find({ order: { id: 'ASC' } }),
		profiles: await manager.getRepository(MiUserProfile).find({ order: { userId: 'ASC' } }),
		relations: await manager.getRepository(MiFollowing).find({ order: { id: 'ASC' } }),
	};
}

// Successful cases execute real reads. Faults below occur at actual TypeORM repository boundaries.
test.each(followCorpus.cases)('$id through normal listening HTTP and PostgreSQL matches independent source', async (c) => {
	await seed(c);
	const manager = resources.dataSource.manager;
	const before = await snapshot();
	const restore: (() => void)[] = [];
	const pathReads = c.pathUser === undefined ? undefined : {
		user: vi.spyOn(manager.getRepository(MiUser), 'findOne'),
		profile: vi.spyOn(manager.getRepository(MiUserProfile), 'findOneByOrFail'),
		relations: vi.spyOn(manager.getRepository(MiFollowing), 'find'),
		member: vi.spyOn(manager.getRepository(MiUser), 'findOneByOrFail'),
		meta: vi.spyOn(manager.getRepository(MiMeta), 'find'),
	};
	if (pathReads) {
		for (const spy of Object.values(pathReads)) {
			restore.push(() => spy.mockRestore());
		}
	}
	if (c.fail === 'user') {
		restore.push(vi.spyOn(manager.getRepository(MiUser), 'findOne').mockRejectedValue(Error('database unavailable')).mockRestore);
	}
	if (c.fail === 'profile') {
		restore.push(vi.spyOn(manager.getRepository(MiUserProfile), 'findOneByOrFail').mockRejectedValue(Error('database unavailable')).mockRestore);
	}
	if (c.fail === 'relations') {
		restore.push(vi.spyOn(manager.getRepository(MiFollowing), 'find').mockRejectedValue(Error('database unavailable')).mockRestore);
	}
	if (c.missingMember || c.fail?.startsWith('member:')) {
		const repo = manager.getRepository(MiUser);
		const original = repo.findOneByOrFail.bind(repo);
		restore.push(vi.spyOn(repo, 'findOneByOrFail').mockImplementation(async where => {
			if (c.missingMember || ('id' in where && where.id === c.fail?.slice('member:'.length))) {
				throw Error('member disappeared after relation read');
			}
			return original(where);
		}).mockRestore);
	}
	try {
		const expected = followSource.cases.find(row => row.id === c.id)!.expected;
		const response = await request(`/users/${c.pathUser ?? 'alice'}/${c.direction}${c.query ?? ''}`, c.method, c.accept);
		expect(response.status).toBe(expected.status);
		for (const [key, value] of Object.entries(expected.headers)) {
			expect(response.headers.get(key), key).toBe(value);
		}
		const cursor = expected.relationCursors[0];
		let sqlRows: { id: string; memberId: string }[] | undefined;
		if ((expected.json || pathReads) && cursor && !/^r\d{3}$/.test(cursor)) {
			// Source doubles use JS ordering; independently query PostgreSQL with the source-observed cursor.
			// HEAD performs the same member reads as GET, even though it has no JSON body to compare.
			const column = c.direction === 'followers' ? 'followeeId' : 'followerId';
			const memberColumn = c.direction === 'followers' ? 'followerId' : 'followeeId';
			sqlRows = await manager.query<{ id: string; memberId: string }[]>(`SELECT id, "${memberColumn}" AS "memberId" FROM following WHERE "${column}" = $1 AND id < $2 ORDER BY id DESC LIMIT 11`, ['alice', cursor]);
		}
		const expectedReadEvents = sqlRows === undefined ? expected.events : [
			...expected.events.filter(event => !event.startsWith('member:')),
			...sqlRows.slice(0, 10).map(row => `member:${row.memberId}`),
		];
		if (expected.json) {
			let json = expected.json;
			if (sqlRows !== undefined) {
				const retained = sqlRows.slice(0, 10);
				const page = { ...json as Record<string, unknown>, orderedItems: retained.map(row => Number(row.memberId.slice(1)) % 2 ? `https://remote.test/${row.memberId}` : `${followCorpus.defaults.selfUrl}/users/${row.memberId}`) };
				if (sqlRows.length === 11) {
					(page as Record<string, unknown>).next = `${followCorpus.defaults.selfUrl}/users/alice/${c.direction}?page=true&cursor=${encodeURIComponent(retained.at(-1)!.id)}`;
				} else {
					delete (page as Record<string, unknown>).next;
				}
				json = page;
			}
			expect(await response.json()).toEqual(json);
		} else if (expected.errorProjection) {
			expect(await response.json()).toMatchObject(expected.errorProjection);
		} else if (expected.bodyEmpty || c.method === 'HEAD') {
			expect(await response.text()).toBe('');
		}
		if (pathReads) {
			expect(pathReads.user.mock.calls.map(([options]) => (options.where as { id: string }).id)).toEqual(expected.lookupIds);
			expect(pathReads.meta).toHaveBeenCalledTimes(expected.metaEntries);
			for (const stage of ['profile', 'relations', 'member'] as const) {
				expect(pathReads[stage]).toHaveBeenCalledTimes(expectedReadEvents.filter(event => event === stage || event.startsWith(`${stage}:`)).length);
			}
			const readEvents = Object.entries(pathReads).flatMap(([stage, spy]) => spy.mock.invocationCallOrder.map((order, index) => ({
				order,
				event: stage === 'member' ? `member:${(pathReads.member.mock.calls[index][0] as { id: string }).id}` : stage,
			}))).sort((a, b) => a.order - b.order).map(call => call.event);
			expect(readEvents).toEqual([...Array.from({ length: expected.metaEntries }, () => 'meta'), ...expectedReadEvents]);
		}
	} finally {
		for (const undo of restore) {
			undo();
		}
	}
	expect(await snapshot()).toEqual(before);
});

test.each(['followers', 'following'] as const)('%s follows every next link with descending relation cursor, no overlap and saved count', async direction => {
	await seed({ id: 'walk', direction, size: 25 });
	const before = await snapshot();
	const base = `/users/alice/${direction}`;
	const index = await (await request(base)).json() as { first: string; totalItems: number };
	expect(index.totalItems).toBe(direction === 'followers' ? 123 : 456);
	let next: string | undefined = index.first;
	const all: (string | null)[] = [];
	const pageSizes: number[] = [];
	const cursors: (string | null)[] = [];
	while (next) {
		const url = new URL(next);
		cursors.push(url.searchParams.get('cursor'));
		const response = await request(url.pathname + url.search);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBeNull();
		const page = await response.json() as { id: string; partOf: string; totalItems: number; orderedItems: (string | null)[]; next?: string; prev?: string };
		expect(page.id).toBe(next);
		expect(page.partOf).toBe(`${followCorpus.defaults.selfUrl}${base}`);
		expect(page.totalItems).toBe(index.totalItems);
		expect(page.prev).toBeUndefined();
		pageSizes.push(page.orderedItems.length);
		all.push(...page.orderedItems);
		next = page.next;
		expect(pageSizes.length).toBeLessThanOrEqual(3);
	}
	expect(pageSizes).toEqual([10, 10, 5]);
	expect(cursors).toEqual([null, 'r016', 'r006']);
	expect(all).toEqual(Array.from({ length: 25 }, (_, i) => {
		const n = 25 - i;
		const id = `u${String(n).padStart(3, '0')}`;
		return n % 2 ? `https://remote.test/${id}` : `${followCorpus.defaults.selfUrl}/users/${id}`;
	}));
	expect(new Set(all).size).toBe(25);
	expect(await snapshot()).toEqual(before);
});

test('fresh profile and Meta reads change the next response; cached HTTP success is not held in process', async () => {
	await seed({ id: 'fresh', direction: 'followers' });
	const manager = resources.dataSource.manager;
	expect((await request('/users/alice/followers')).headers.get('cache-control')).toBe('public, max-age=180');
	await manager.getRepository(MiUserProfile).update('alice', { followersVisibility: 'private' });
	const denied = await request('/users/alice/followers?page=true');
	expect(denied.status).toBe(403);
	expect(denied.headers.get('cache-control')).toBe('public, max-age=30');
	await manager.getRepository(MiMeta).update('singleton', { federation: 'none' });
	const disabled = await request('/users/alice/followers?cursor=a&cursor=b');
	expect(disabled.status).toBe(403);
	expect(disabled.headers.get('cache-control')).toBeNull();
	await manager.getRepository(MiMeta).update('singleton', { federation: 'all' });
	await manager.getRepository(MiUserProfile).update('alice', { followersVisibility: 'public' });
	await manager.getRepository(MiUser).update('alice', { followersCount: 987 });
	expect(await (await request('/users/alice/followers')).json()).toMatchObject({ totalItems: 987 });
});

test('Meta initialization is the existing permitted write; read failure returns an uncached 500 and recovers', async () => {
	await seed({ id: 'meta', direction: 'following' });
	const repo = resources.dataSource.getRepository(MiMeta);
	await repo.delete('singleton');
	expect((await request('/users/alice/following')).status).toBe(403);
	expect((await repo.find()).map(row => row.id)).toEqual(['x']);
	await repo.delete('x');
	await repo.insert({ id: 'singleton', federation: 'all' });
	const fault = vi.spyOn(repo, 'find').mockRejectedValue(Error('Meta unavailable'));
	try {
		const response = await request('/users/alice/following');
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBeNull();
		expect(await response.json()).toMatchObject({ error: 'Internal Server Error' });
	} finally {
		fault.mockRestore();
	}
	expect((await request('/users/alice/following')).status).toBe(200);
});

test.each(['followers', 'following'] as const)('%s fails if a member really disappears after relation retrieval; it does not return partial data', async direction => {
	await seed({ id: 'deleted-member', direction });
	const repo = resources.dataSource.getRepository(MiUser);
	const original = repo.findOneByOrFail.bind(repo);
	let deleted = false;
	const race = vi.spyOn(repo, 'findOneByOrFail').mockImplementation(async where => {
		if ('id' in where && where.id === 'u011') {
			await repo.delete('u011');
			deleted = true;
		}
		return original(where);
	});
	try {
		const response = await request(`/users/alice/${direction}?page=true`);
		expect(deleted).toBe(true);
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBeNull();
	} finally {
		race.mockRestore();
	}
	expect(await repo.existsBy({ id: 'u011' })).toBe(false);
	expect(await resources.dataSource.getRepository(MiFollowing).count()).toBe(10);
});
