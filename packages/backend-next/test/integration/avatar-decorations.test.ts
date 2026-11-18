/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAvatarDecoration, MiRole, MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import source from '../../../../docs/superpowers/compatibility/avatar-decorations/observations.json' with { type: 'json' };
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
const token = '0123456789abcdef';
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('avatar-decorations-test', () => {}));
	await resources.dataSource.getRepository(MiAvatarDecoration).insert(source.rows.map(row => ({ ...row, updatedAt: row.updatedAt ? new Date(row.updatedAt) : null })));
	await resources.dataSource.getRepository(MiRole).insert(source.roles.map(role => ({ ...role, name: role.id, description: '', updatedAt: new Date(0), lastUsedAt: new Date(0) })));
	await resources.dataSource.getRepository(MiUser).insert({ id: 'viewer', username: 'viewer', usernameLower: 'viewer', token });
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
const request = (input: Record<string, unknown> = {}) => fetch(url + '/api/get-avatar-decorations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });

for (const sample of source.projection) {
	test(`normal listening HTTP and persisted decoration/roles match source callback: authenticated=${sample.authenticated}`, async () => {
		const response = await request(sample.authenticated ? { i: token } : {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(sample.result);
	});
}

test('public endpoint bypasses warm cache and returns current persisted values', async () => {
	await resources.avatarDecorations.getAll();
	await resources.dataSource.getRepository(MiAvatarDecoration).update('second', { name: 'fresh' });
	expect((await resources.avatarDecorations.getAll()).find(row => row.id === 'second')!.name).toBe(source.rows[0].name);
	const response = await request();
	expect(response.status).toBe(200);
	expect((await response.json()).find((row: { id: string }) => row.id === 'second').name).toBe('fresh');
	expect((await resources.avatarDecorations.getAll()).find(row => row.id === 'second')!.name).toBe('fresh');
});

for (const type of ['avatarDecorationCreated', 'avatarDecorationUpdated', 'avatarDecorationDeleted']) {
	test(`real Redis ${type} invalidates cached decoration rows`, async () => {
		await resources.avatarDecorations.getAll(true);
		await resources.dataSource.getRepository(MiAvatarDecoration).update('second', { description: type });
		expect((await resources.avatarDecorations.getAll()).find(row => row.id === 'second')!.description).not.toBe(type);
		await resources.redis.publish(new URL(database.config.url).host, JSON.stringify({ channel: 'internal', message: { type, body: {} } }));
		await vi.waitFor(async () => {
			expect((await resources.avatarDecorations.getAll()).find(row => row.id === 'second')!.description).toBe(type); 
		});
	});
}

test('warm cache survives unavailable DB; public forced read fails, clears cache, and retries after restoration', async () => {
	await resources.avatarDecorations.getAll(true);
	await resources.dataSource.query('ALTER TABLE "avatar_decoration" RENAME TO "avatar_decoration_fault"');
	try {
		expect((await resources.avatarDecorations.getAll()).length).toBe(2);
		const response = await request();
		expect(response.status).toBe(500);
		expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
		await expect(resources.avatarDecorations.getAll()).rejects.toThrow();
	} finally {
		await resources.dataSource.query('ALTER TABLE "avatar_decoration_fault" RENAME TO "avatar_decoration"');
	}
	expect((await request()).status).toBe(200);
});

test('invalid credentials and unsupported GET retain common gate behavior', async () => {
	expect((await request({ i: 'bad' })).status).toBe(401);
	expect((await fetch(url + '/api/get-avatar-decorations')).status).toBe(405);
});

test('empty stored decorations return an empty list', async () => {
	await resources.dataSource.getRepository(MiAvatarDecoration).clear();
	expect(await (await request()).json()).toEqual([]);
});
