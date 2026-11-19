/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiAccessToken, MiDriveFile, MiDriveFolder, MiMeta, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
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
let folderId: string;
const files = () => resources.dataSource.getRepository(MiDriveFile);

async function call(path: string, input: object = {}, token: string | null = seed.actors.ordinary.token) {
	return fetch(`${origin}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('drive-list-test', () => {}));
	seed = await seedRoleHttp(resources.dataSource);
	folderId = seed.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiDriveFolder).insert({ id: folderId, userId: seed.actors.ordinary.id, name: 'folder' });
	await files().insert([
		{ storedInternal: true, id: '0000000100000001', userId: seed.actors.ordinary.id, name: 'a.png', type: 'image/png', md5: 'a', size: 10, url: 'https://files/a' },
		{ storedInternal: true, id: '0000000200000002', userId: seed.actors.ordinary.id, name: 'c.jpg', type: 'image/jpeg', md5: 'b', size: 30, url: 'https://files/b', isLink: true },
		{ storedInternal: true, id: '0000000300000003', userId: seed.actors.ordinary.id, name: 'b.txt', type: 'text/plain', md5: 'c', size: 20, url: 'https://files/c', folderId },
	]);
	app = createBackendHttpApp(resources, database.config);
	server = await listenHttp(app, { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	if (app) {
		await drainHttpAppWork(app);
	}
	await resources?.close();
	await database?.close();
});
test('Drive usage excludes links across folders and returns current Role capacity', async () => {
	const response = await call('drive');
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ usage: 30, capacity: 100 * 1024 * 1024 });
});
test('file root filter and stream pagination keep exclusive boundaries', async () => {
	const root = await call('drive/files');
	expect(root.status).toBe(200);
	expect((await root.json()).map((f: { id: string }) => f.id)).toEqual(['0000000200000002', '0000000100000001']);
	const next = await call('drive/stream', { sinceId: '0000000100000001', limit: 1 });
	expect(next.status).toBe(200);
	expect((await next.json()).map((f: { id: string }) => f.id)).toEqual(['0000000200000002']);
});
test('Role capacity follows current assignments, priority and expiry; empty users have zero usage', async () => {
	const roles = resources.dataSource.getRepository(MiRole);
	const assignments = resources.dataSource.getRepository(MiRoleAssignment);
	const roleId = seed.codec.newId(Date.now());
	const assignmentId = seed.codec.newId(Date.now());
	await roles.save({ id: roleId, name: 'drive-capacity', description: '', updatedAt: new Date(), lastUsedAt: new Date(), policies: { driveCapacityMb: { useDefault: false, priority: 2, value: 7 } } });
	await assignments.insert({ id: assignmentId, roleId, userId: seed.actors.ordinary.id });
	try {
		expect(await (await call('drive')).json()).toEqual({ usage: 30, capacity: 7 * 1024 * 1024 });
		await assignments.update(assignmentId, { expiresAt: new Date(0) });
		expect(await (await call('drive')).json()).toEqual({ usage: 30, capacity: 100 * 1024 * 1024 });
		await resources.dataSource.getRepository(MiMeta).save({ id: 'singleton', policies: { driveCapacityMb: 3 } });
		expect(await (await call('drive', {}, seed.actors.moderator.token)).json()).toEqual({ usage: 0, capacity: 3 * 1024 * 1024 });
	} finally {
		await assignments.delete(assignmentId);
		await roles.delete(roleId);
		await resources.dataSource.getRepository(MiMeta).update('singleton', { policies: {} });
	}
});
test('self lists retain raw URL/properties and owner ID; admin includes preloaded folder and UserLite', async () => {
	await files().update('0000000300000003', { properties: { width: 10, height: 20, orientation: 6 }, webpublicUrl: 'https://files/public' });
	const own = await (await call('drive/files', { folderId })).json();
	expect(own).toHaveLength(1);
	expect(own[0]).toMatchObject({ id: '0000000300000003', url: 'https://files/c', properties: { width: 10, height: 20, orientation: 6 }, userId: seed.actors.ordinary.id, folder: null, user: null });
	const admin = await (await call('admin/drive/files', { userId: seed.actors.ordinary.id }, seed.actors.moderator.token)).json();
	expect(admin[0]).toMatchObject({ id: '0000000300000003', folder: { id: folderId, name: 'folder', filesCount: 1, foldersCount: 0 }, user: { id: seed.actors.ordinary.id, username: 'ordinary', avatarDecorations: [] }, url: 'https://files/c' });
	expect(admin[0]).not.toHaveProperty('requestHeaders');
	expect(admin[0]).not.toHaveProperty('accessKey');
});
test('cursor pages remain exclusive across deletion, with current zero usage after deletion', async () => {
	const rows = await files().find();
	try {
		const first = await (await call('drive/stream', { limit: 1 })).json();
		expect(first[0].id).toBe('0000000300000003');
		await files().delete(first[0].id);
		const page = await (await call('drive/stream', { untilId: first[0].id })).json();
		expect(page.map((row: { id: string }) => row.id)).toEqual(['0000000200000002', '0000000100000001']);
		expect(await (await call('drive')).json()).toHaveProperty('usage', 10);
		await files().delete('0000000100000001');
		expect(await (await call('drive')).json()).toHaveProperty('usage', 0);
		await files().delete('0000000200000002');
		expect(await (await call('drive/stream', { untilId: first[0].id })).json()).toEqual([]);
		expect(await (await call('drive')).json()).toHaveProperty('usage', 0);
	} finally {
		await files().deleteAll();
		await files().insert(rows);
	}
});
test('all routes reject guest, wrong scope and suspended accounts before invalid inputs; moderator gate is current', async () => {
	const tokens = resources.dataSource.getRepository(MiAccessToken);
	for (const [name, user, permission] of [
		['read', 'ordinary', ['read:drive']], ['admin', 'moderator', ['read:admin:drive']],
		['admin-ordinary', 'ordinary', ['read:admin:drive']],
	] as const) {
		await tokens.insert({ id: seed.codec.newId(Date.now()), userId: seed.actors[user].id, token: `list-${name}`, hash: `list-${name}-hash`, permission: [...permission] });
	}
	for (const path of ['drive', 'drive/files', 'drive/stream', 'drive/folders', 'admin/drive/files']) {
		expect((await call(path, { limit: 0 }, null)).status).toBe(401);
		const suspended = await call(path, { limit: 0 }, seed.actors.suspended.token);
		expect(await suspended.json()).toHaveProperty('error.code', 'YOUR_ACCOUNT_SUSPENDED');
		const noScope = await call(path, { limit: 0 }, seed.actors.ordinaryNoScope.token);
		expect(noScope.status).toBe(403);
		const valid = await call(path, {}, path.startsWith('admin') ? 'list-admin' : 'list-read');
		expect(valid.status).toBe(200);
	}
	expect((await call('admin/drive/files', {}, 'list-read')).status).toBe(403);
	expect((await call('admin/drive/files', {}, 'list-admin-ordinary')).status).toBe(403);
	await resources.dataSource.getRepository(MiRoleAssignment).update({ userId: seed.actors.moderator.id }, { expiresAt: new Date(0) });
	try {
		expect((await call('admin/drive/files', {}, 'list-admin')).status).toBe(403);
	} finally {
		await resources.dataSource.getRepository(MiRoleAssignment).update({ userId: seed.actors.moderator.id }, { expiresAt: null });
	}
});
test('real database read failures return 500 without partial arrays or zero usage; reads leave persisted rows unchanged', async () => {
	const before = await files().find();
	await resources.dataSource.query('ALTER TABLE drive_file RENAME TO drive_file_507_unavailable');
	try {
		for (const path of ['drive', 'drive/files', 'drive/stream', 'admin/drive/files']) {
			const response = await call(path, {}, path.startsWith('admin') ? seed.actors.moderator.token : seed.actors.ordinary.token);
			expect(response.status).toBe(500);
			expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
		}
	} finally {
		await resources.dataSource.query('ALTER TABLE drive_file_507_unavailable RENAME TO drive_file');
	}
	await resources.dataSource.query('ALTER TABLE drive_folder RENAME TO drive_folder_507_unavailable');
	try {
		expect((await call('drive/folders')).status).toBe(500);
	} finally {
		await resources.dataSource.query('ALTER TABLE drive_folder_507_unavailable RENAME TO drive_folder');
	}
	expect(await files().find()).toEqual(before);
});
