/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiAccessToken, MiAvatarDecoration, MiMeta, MiModerationLog, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { openInternalEvents } from '../../src/platform/internal-events.js';
import { createAvatarDecorationCache } from '../../src/platform/avatar-decoration-cache.js';
import { createAvatarDecorationReader } from '../../src/platform/database/avatar-decorations.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { avatarDecorationSourceAccess, createAvatarDecorationSource } from '../helpers/avatar-decoration-source.js';
import type { Server } from 'node:http';
import type { InternalEvent } from '../../src/platform/internal-events.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let events: Awaited<ReturnType<typeof openInternalEvents>>;
let peer: ReturnType<typeof createAvatarDecorationCache>;
let app: ReturnType<typeof createBackendHttpApp>;
let server: Server;
let url: string;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
const received: InternalEvent[] = [];
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
beforeAll(async () => {
	database = await createTestDatabase();
	database.config.redisForPubsub = { ...database.config.redis, port: Number(process.env.BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT ?? 56380) };
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('decoration-admin-test', () => {}));
	seed = await seedRoleHttp(resources.dataSource);
	await resources.dataSource.getRepository(MiMeta).createQueryBuilder().update().set({ rootUserId: seed.actors.root.id }).execute();
	const roleId = seed.codec.newId();
	await resources.dataSource.getRepository(MiRole).insert({ id: roleId, name: 'decoration-manager', description: '', updatedAt: new Date(), lastUsedAt: new Date(), isPublic: false });
	await resources.dataSource.query('UPDATE role SET policies = $1 WHERE id = $2', [JSON.stringify({ canManageAvatarDecorations: { priority: 1, useDefault: false, value: true } }), roleId]);
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: seed.codec.newId(), userId: seed.actors.ordinary.id, roleId });
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: seed.codec.newId(), userId: seed.actors.ordinary.id, token: 'decoration-read-token', hash: 'decoration-read-token', permission: ['read:admin:avatar-decorations'] },
		{ id: seed.codec.newId(), userId: seed.actors.ordinary.id, token: 'decoration-write-token', hash: 'decoration-write-token', permission: ['write:admin:avatar-decorations'] },
	]);
	events = await openInternalEvents({ subscriberConfig: database.config.redisForPubsub, url: database.config.url, onError: error => {
		throw error;
	} });
	events.register({ onInternal(event) {
		received.push(event);
	} });
	peer = createAvatarDecorationCache({ events, read: createAvatarDecorationReader(resources.dataSource.manager) });
	app = createBackendHttpApp(resources, database.config);
	server = await listenHttp(app, { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	if (app) {
		await drainHttpAppWork(app);
	}
	await peer?.close();
	await events?.close();
	await resources?.close();
	await database?.close();
});
beforeEach(async () => {
	await drainHttpAppWork(app);
	await resources.dataSource.getRepository(MiAvatarDecoration).clear();
	await resources.dataSource.getRepository(MiModerationLog).clear();
	received.length = 0;
	await peer.getAll(true);
});

async function call(operation: string, params: object = {}, token: string | null = seed.actors.root.token) {
	return fetch(`${url}/api/admin/avatar-decorations/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, i: token }) });
}

async function logs() {
	await drainHttpAppWork(app);
	return json((await resources.dataSource.getRepository(MiModerationLog).find({ order: { id: 'ASC' } })).map(row => ({ actorId: row.userId, type: row.type, info: row.info })));
}

const attributes = { name: '星 & 🌟', description: '<description>', url: 'not-a-url', category: 'category', roleIdsThatCanBeUsedThisDecoration: ['private', 'private', 'missing'] };

test('listening HTTP create/update/delete match literal pinned callbacks and service over PostgreSQL, including events and logs', async () => {
	const createdResponse = await call('create', attributes);
	expect(createdResponse.status).toBe(200);
	const created = await createdResponse.json();
	await vi.waitFor(async () => {
		expect(await peer.getAll()).toHaveLength(1);
	});
	const patch = { id: created.id, name: 'updated', category: null };
	expect((await call('update', patch)).status).toBe(204);
	await vi.waitFor(async () => {
		expect((await peer.getAll())[0].name).toBe('updated');
	});
	const listed = await (await call('list', { limit: 1, sinceId: 'zzzz', userId: null })).json();
	expect(listed).toHaveLength(1);
	const publicResponse = await fetch(`${url}/api/get-avatar-decorations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	expect(await publicResponse.json()).toEqual([{ id: created.id, ...attributes, name: 'updated', category: null, roleIdsThatCanBeUsedThisDecoration: [] }]);
	expect((await call('delete', { id: created.id })).status).toBe(204);
	await vi.waitFor(async () => {
		expect(await peer.getAll()).toEqual([]);
	});
	const actualLogs = await logs();
	await vi.waitFor(() => expect(received).toHaveLength(3));
	const actualEvents = json(received);
	const source = createAvatarDecorationSource(resources.dataSource.manager, created.id, Date.parse(created.createdAt), Date.parse(listed[0].updatedAt));
	expect(json(await source.call('create', attributes, seed.actors.root.id))).toEqual(created);
	await source.call('update', patch, seed.actors.root.id);
	expect(json(await source.call('list', { limit: 1, sinceId: 'zzzz', userId: null }, seed.actors.root.id))).toEqual(listed);
	await source.call('delete', { id: created.id }, seed.actors.root.id);
	expect(json(source.logs)).toEqual(actualLogs);
	expect(json(source.events)).toEqual(actualEvents);
	expect(await resources.dataSource.getRepository(MiAvatarDecoration).count()).toBe(0);
});

test('omitted create defaults, no-op update timestamp and complete list preserve rows and restriction ordering', async () => {
	const one = await (await call('create', { name: 'one', description: '', url: 'x' })).json();
	expect(one).toMatchObject({ updatedAt: null, category: null, roleIdsThatCanBeUsedThisDecoration: [] });
	const two = await (await call('create', attributes)).json();
	expect((await call('update', { id: one.id })).status).toBe(204);
	const response = await call('list', { limit: 1, untilId: 'a' });
	const rows = await response.json();
	expect(rows).toHaveLength(2);
	expect(rows.find((row: { id: string }) => row.id === one.id)).toMatchObject({ name: 'one', category: null, updatedAt: expect.any(String) });
	expect(rows.find((row: { id: string }) => row.id === two.id).roleIdsThatCanBeUsedThisDecoration).toEqual(attributes.roleIdsThatCanBeUsedThisDecoration);
});

for (const [actor, expected] of [['root', 200], ['administrator', 200], ['ordinary', 200], ['moderator', 403], ['expired', 403], ['suspended', 403], ['invalid', 401]] as const) {
	test(`persisted role authorization: ${actor}`, async () => {
		const response = await call('list', {}, seed.actors[actor].token);
		expect(response.status).toBe(expected);
		if (actor !== 'invalid') {
			const expectedError = await avatarDecorationSourceAccess({ root: actor === 'root', administrator: actor === 'administrator' || actor === 'suspended', policy: actor === 'ordinary', suspended: actor === 'suspended', permissions: null }, 'list');
			if (expectedError) {
				expect((await response.clone().json()).error).toMatchObject(expectedError);
			}
		}
		if (actor === 'moderator' || actor === 'expired') {
			expect((await response.json()).error).toMatchObject({ code: 'ROLE_PERMISSION_DENIED', id: '7f86f06f-7e15-4057-8561-f4b6d4ac755a' });
		}
		if (actor === 'suspended') {
			expect((await response.json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
		}
	});
}

test('read/write scopes, credential requirement, malformed input and unsupported GET use normal gate', async () => {
	expect((await call('list', {}, null)).status).toBe(401);
	expect((await call('list', {}, 'decoration-read-token')).status).toBe(200);
	expect((await call('create', attributes, 'decoration-read-token')).status).toBe(403);
	expect((await call('create', attributes, 'decoration-write-token')).status).toBe(200);
	expect((await call('list', {}, 'decoration-write-token')).status).toBe(403);
	for (const [operation, input] of [['create', { name: '', description: '', url: 'x' }], ['update', { id: 'bad-id' }], ['delete', {}], ['list', { limit: 101 }]] as const) {
		const response = await call(operation, input);
		expect(response.status).toBe(400);
		expect((await response.json()).error.code).toBe('INVALID_PARAM');
	}
	expect((await fetch(`${url}/api/admin/avatar-decorations/list`)).status).toBe(405);
});

for (const operation of ['update', 'delete']) {
	test(`${operation} nonexistent ID retains pinned general failure and has no effects`, async () => {
		const response = await call(operation, { id: 'absent' });
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
		const source = createAvatarDecorationSource(resources.dataSource.manager, 'absent', 1, 1);
		await expect(source.call(operation, { id: 'absent' }, seed.actors.root.id)).rejects.toThrow();
		expect(await logs()).toEqual(source.logs);
		expect(received).toEqual(source.events);
	});
}

test('database write failure yields no new row, event or audit and succeeds after restoration', async () => {
	await resources.dataSource.query('ALTER TABLE "avatar_decoration" ADD CONSTRAINT "decoration_write_fault" CHECK (false)');
	try {
		const response = await call('create', attributes);
		expect(response.status).toBe(500);
		expect(await resources.dataSource.getRepository(MiAvatarDecoration).count()).toBe(0);
		expect(await logs()).toEqual([]);
		expect(received).toEqual([]);
		const source = createAvatarDecorationSource(resources.dataSource.manager, seed.codec.newId(), 1, 1);
		await expect(source.call('create', attributes, seed.actors.root.id)).rejects.toThrow();
		expect(source.logs).toEqual([]);
		expect(source.events).toEqual([]);
	} finally {
		await resources.dataSource.query('ALTER TABLE "avatar_decoration" DROP CONSTRAINT "decoration_write_fault"');
	}
	expect((await call('create', attributes)).status).toBe(200);
});

test('failed event publication and diagnostic logger preserve saved HTTP success and drain accepted work', async () => {
	const publish = vi.spyOn(resources, 'publishInternalEvent').mockRejectedValue(new Error('Redis publish fault'));
	const diagnostic = vi.spyOn(resources.logger, 'error').mockImplementation(() => {
		throw new Error('diagnostic fault');
	});
	try {
		const response = await call('create', attributes);
		expect(response.status).toBe(200);
		await expect(drainHttpAppWork(app)).resolves.toBeUndefined();
		expect(await resources.dataSource.getRepository(MiAvatarDecoration).count()).toBe(1);
		expect(await logs()).toHaveLength(1);
		expect(diagnostic).toHaveBeenCalled();
	} finally {
		publish.mockRestore();
		diagnostic.mockRestore();
	}
});

test('literal pinned policy and scope gate matches real delegated read/write tokens', async () => {
	for (const operation of ['create', 'list']) {
		for (const scope of ['read', 'write']) {
			const expectedError = await avatarDecorationSourceAccess({ root: false, administrator: false, policy: true, suspended: false, permissions: [`${scope}:admin:avatar-decorations`] }, operation);
			const response = await call(operation, operation === 'create' ? attributes : {}, `decoration-${scope}-token`);
			if (expectedError) {
				expect((await response.json()).error).toMatchObject(expectedError);
			} else {
				expect(response.status).toBe(200);
			}
		}
	}
});
