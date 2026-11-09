/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiMeta, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let remoteId: string;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('http-app-test', () => {}));
	remoteId = createIdCodec(database.config.id).newId(Date.now());
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	await resources.dataSource.getRepository(MiUser).insert({ id: remoteId, username: 'remote', usernameLower: 'remote', host: 'remote.test', uri: 'https://remote.test/users/remote' });
	app = createBackendHttpApp(resources, database.config);
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
});

test('canonical root reaches real Actor, Role and Note adapters without queue routes', async () => {
	const actor = await app.request(`/users/${remoteId}`, { headers: { Accept: 'application/activity+json' } });
	expect(actor.status).toBe(301);
	expect(actor.headers.get('location')).toBe('https://remote.test/users/remote');
	for (const path of ['admin/roles/show', 'admin/roles/update', 'notes/delete', 'notes/create']) {
		const response = await app.request(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		expect(response.status).toBe(401);
	}
	const show = await app.request('/api/notes/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId: remoteId }) });
	expect(show.status).toBe(400);
	expect(await show.json()).toHaveProperty('error.code', 'NO_SUCH_NOTE');
	expect((await app.request('/api/admin/queue/stats', { method: 'POST' })).status).toBe(404);
	expect((await app.request('/unknown')).status).toBe(404);
});
