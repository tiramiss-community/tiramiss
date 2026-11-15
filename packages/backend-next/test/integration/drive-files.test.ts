/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiDriveFile, MiDriveFolder, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
let app: ReturnType<typeof createBackendHttpApp>;
let server: Server;
let origin: string;
let fileId: string;
let folderId: string;
let parentId: string;
let otherId: string;
let unownedId: string;
const logs: string[] = [];
const files = () => resources.dataSource.getRepository(MiDriveFile);

function call(name: string, input: unknown, token: string | null = seed.actors.ordinary.token, method = 'POST') {
	const path = name === 'admin' ? 'admin/drive/show-file' : `drive/files/${name}`;
	return fetch(`${origin}/api/${path}${method === 'GET' ? `?${new URLSearchParams(input as Record<string, string>)}` : ''}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(input) }) });
}

beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	database.config.url = 'https://files.example';
	resources = await connectResources(database.config, createLogger('file-read-test', line => logs.push(line)));
	seed = await seedRoleHttp(resources.dataSource);
	const id = () => seed.codec.newId(Date.now());
	[fileId, folderId, parentId, otherId, unownedId] = [id(), id(), id(), id(), id()];
	await resources.dataSource.getRepository(MiDriveFolder).insert([
		{ id: parentId, userId: seed.actors.ordinary.id, name: 'parent', parentId: null },
		{ id: folderId, userId: seed.actors.ordinary.id, name: 'child', parentId },
	]);
	const base = { storedInternal: true, name: 'same.png', type: 'image/png', md5: '0'.repeat(32), size: 1, url: 'https://storage/original', webpublicUrl: 'https://storage/public', thumbnailUrl: 'https://storage/thumb', properties: { width: 10, height: 20, orientation: 6 }, requestIp: '192.0.2.1', requestHeaders: { host: 'upload.test' } };
	await files().insert([
		{ ...base, id: fileId, userId: seed.actors.ordinary.id, folderId },
		{ ...base, id: otherId, userId: seed.actors.moderator.id, url: 'https://storage/mod' },
		{ ...base, id: unownedId, userId: null, url: 'https://storage/unowned' },
	]);
	for (const [token, userId, permission] of [
		['drive-read-token', seed.actors.ordinary.id, ['read:drive']],
		['drive-admin-token', seed.actors.moderator.id, ['read:admin:drive']],
		['drive-mod-read-token', seed.actors.moderator.id, ['read:drive']],
	] as const) {
		await resources.dataSource.getRepository(MiAccessToken).insert({ id: id(), userId, token, hash: `${token}-hash`, permission: [...permission] });
	}
	app = createBackendHttpApp(resources, database.config); server = await listenHttp(app, { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} if (app) {
		await drainHttpAppWork(app);
	} await resources?.close(); await database?.close(); 
});
test('ID and three URL variants show owner self/detail/UserLite; no database writes', async () => {
	const before = await files().find();
	for (const input of [{ fileId }, { url: 'https://storage/original' }, { url: 'https://storage/public' }, { url: 'https://storage/thumb' }, { fileId, url: 'missing' }]) {
		const response = await call('show', input);
		expect(response.status, await response.clone().text()).toBe(200);
		const view = await response.json();
		expect(view).toMatchObject({ id: fileId, url: 'https://storage/original', thumbnailUrl: 'https://storage/thumb', userId: seed.actors.ordinary.id, properties: { width: 10, height: 20, orientation: 6 },
																															folder: { id: folderId, name: 'child', foldersCount: 0, filesCount: 1, parent: { id: parentId, foldersCount: 1, filesCount: 0 } },
																															user: { id: seed.actors.ordinary.id, username: 'ordinary', host: null, isBot: false, isCat: false, avatarDecorations: [], emojis: {}, onlineStatus: 'unknown', badgeRoles: [] } });
		expect(view).not.toHaveProperty('requestIp'); expect(view).not.toHaveProperty('accessKey');
	}
	expect(await files().find()).toEqual(before);
	expect((await call('show', { fileId }, 'drive-read-token', 'GET')).status).toBe(405);
});
test('show denies non-owner; moderators/admin/root can inspect other and unowned files', async () => {
	const denied = await call('show', { fileId: otherId });
	expect(denied.status).toBe(400); expect(await denied.json()).toHaveProperty('error.code', 'ACCESS_DENIED');
	for (const actor of ['moderator', 'administrator', 'root']) {
		for (const id of [fileId, otherId, unownedId]) {
			expect((await call('show', { fileId: id }, seed.actors[actor].token)).status).toBe(200);
		}
	}
	expect((await call('show', { fileId }, 'drive-mod-read-token')).status).toBe(200);
});
test('exact name/folder and hash/existence always restrict to actor; root default and missing return empty/false', async () => {
	expect(await (await call('find', { name: 'same.png' })).json()).toEqual([]);
	const result = await (await call('find', { name: 'same.png', folderId })).json();
	expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: fileId, folder: null, user: null, userId: seed.actors.ordinary.id, url: 'https://storage/original' });
	for (const [actor, expected] of [['ordinary', fileId], ['moderator', otherId]] as const) {
		expect((await (await call('find-by-hash', { md5: '0'.repeat(32) }, seed.actors[actor].token)).json()).map((f: { id: string }) => f.id)).toEqual([expected]);
		expect(await (await call('check-existence', { md5: '0'.repeat(32) }, seed.actors[actor].token)).json()).toBe(true);
	}
	expect(await (await call('find-by-hash', { md5: '' })).json()).toEqual([]);
	expect(await (await call('check-existence', { md5: '' })).json()).toBe(false);
	expect(await (await call('find', { name: 'SAME.png', folderId })).json()).toEqual([]);
});
test('admin uses raw persisted fields and protects moderator headers, including conditional and expired roles', async () => {
	const ordinary = await (await call('admin', { fileId }, 'drive-admin-token')).json();
	expect(ordinary).toMatchObject({ requestIp: '192.0.2.1', requestHeaders: { host: 'upload.test' }, properties: { orientation: 6 }, url: 'https://storage/original', webpublicUrl: 'https://storage/public', userHost: null, isLink: false, storedInternal: true });
	for (const id of [otherId, unownedId]) {
		const response = await call('admin', { fileId: id }, seed.actors.root.token); expect(response.status).toBe(200);
		expect(await response.json()).toHaveProperty('requestHeaders', id === otherId ? null : { host: 'upload.test' });
	}
	const role = seed.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiRole).insert({ id: role, name: 'conditional mod', description: '', isModerator: true, target: 'conditional', condFormula: { id: 'bot-rule', type: 'isBot' }, updatedAt: new Date(), lastUsedAt: new Date() });
	await resources.dataSource.getRepository(MiUser).update(seed.actors.ordinary.id, { isBot: true });
	expect(await (await call('admin', { fileId }, seed.actors.root.token)).json()).toHaveProperty('requestHeaders', null);
	await resources.dataSource.getRepository(MiUser).update(seed.actors.ordinary.id, { isBot: false });
	await resources.dataSource.getRepository(MiRole).delete(role);
	const expired = seed.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiRole).insert({ id: expired, name: 'expired', description: '', isModerator: true, updatedAt: new Date(), lastUsedAt: new Date() });
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: seed.codec.newId(Date.now()), roleId: expired, userId: seed.actors.ordinary.id, expiresAt: new Date(0) });
	expect(await (await call('admin', { fileId }, seed.actors.root.token)).json()).toHaveProperty('requestHeaders', { host: 'upload.test' });
	await resources.dataSource.getRepository(MiRole).delete(expired);
});
test.each(['show', 'find', 'find-by-hash', 'check-existence', 'admin'])('%s gates credential/suspension/scope before input', async name => {
	for (const [token, status, code] of [[null, 401, 'CREDENTIAL_REQUIRED'], ['invalid', 401, 'AUTHENTICATION_FAILED'], [seed.actors.suspended.token, 403, 'YOUR_ACCOUNT_SUSPENDED'], [seed.actors.readScope.token, 403, 'PERMISSION_DENIED']] as const) {
		const response = await call(name, {}, token); expect(response.status).toBe(status); expect(await response.json()).toHaveProperty('error.code', code);
	}
	if (name === 'admin') {
		const response = await call(name, {}, seed.actors.ordinary.token); expect(response.status).toBe(403); expect(await response.json()).toHaveProperty('error.code', 'ROLE_PERMISSION_DENIED');
	}
	const response = await call(name, {}, name === 'admin' ? seed.actors.root.token : seed.actors.ordinary.token);
	expect(response.status).toBe(400); expect(await response.json()).toHaveProperty('error.code', 'INVALID_PARAM');
});
test('missing endpoint error IDs differ and malformed ID plus valid URL preserves ID selection', async () => {
	for (const [name, id] of [['show', '067bc436-2718-4795-b0fb-ecbe43949e31'], ['admin', 'caf3ca38-c6e5-472e-a30c-b05377dcc240']]) {
		const response = await call(name, { fileId: 'missing' }, seed.actors.root.token); expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: 'NO_SUCH_FILE', id } });
	}
	const response = await call('show', { fileId: 'bad-id', url: 'https://storage/original' });
	expect(response.status).toBe(400); expect(await response.json()).toHaveProperty('error.code', 'NO_SUCH_FILE');
});
test('actual PostgreSQL read denial and preloading failure stay INTERNAL_ERROR, never missing/empty/false', async () => {
	const runner = resources.dataSource.createQueryRunner(); await runner.connect();
	try {
		await runner.query('ALTER TABLE drive_file RENAME TO drive_file_unavailable');
		for (const [name, input] of [['show', { fileId }], ['find', { name: 'same.png' }], ['find-by-hash', { md5: '' }], ['check-existence', { md5: '' }], ['admin', { fileId }]] as const) {
			const response = await call(name, input, seed.actors.root.token); expect(response.status).toBe(500); expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
		}
	} finally {
		await runner.query('ALTER TABLE drive_file_unavailable RENAME TO drive_file'); await runner.release(); 
	}
	const repository = resources.dataSource.getRepository(MiDriveFolder);
	const read = vi.spyOn(repository, 'findOneBy').mockRejectedValueOnce(Error('folder query unavailable'));
	const response = await call('show', { fileId }); read.mockRestore();
	expect(response.status).toBe(500); expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
	expect(logs.some(line => line.includes('api.failed'))).toBe(true);
});

test('mixed folder snapshots fail with a controlled internal error before recursive rendering', async () => {
	const repository = resources.dataSource.getRepository(MiDriveFolder);
	const original = repository.findOneBy.bind(repository);
	const mixed = vi.spyOn(repository, 'findOneBy').mockImplementation(async where => {
		const row = await original(where);
		return row?.id === parentId ? { ...row, parentId: folderId } : row;
	});
	try {
		const response = await call('show', { fileId });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR', info: { e: { message: 'Drive folder hierarchy contains a cycle.' } } } });
	} finally {
		mixed.mockRestore();
	}
	const next = await call('show', { fileId });
	expect(next.status).toBe(200);
	expect(await next.json()).toMatchObject({ folder: { id: folderId, parent: { id: parentId } } });
});
