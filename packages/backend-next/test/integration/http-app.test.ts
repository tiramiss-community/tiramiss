/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiMeta, MiModerationLog, MiRole, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let remoteId: string;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('http-app-test', () => {}));
	remoteId = createIdCodec(database.config.id).newId(Date.now());
	seed = await seedRoleHttp(resources.dataSource);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
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

test('canonical root performs authenticated Role show and update', async () => {
	const request = (operation: string, input: object) => app.request(`/api/admin/roles/${operation}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ i: seed.actors.root.token, roleId: seed.roleId, ...input }),
	});
	const show = await request('show', {});
	expect(show.status).toBe(200);
	expect(await show.json()).toMatchObject({ id: seed.roleId, name: 'target' });
	const auditCount = await resources.dataSource.getRepository(MiModerationLog).countBy({ type: 'updateRole' });
	const update = await request('update', { name: 'canonical-root-composed-role' });
	expect(update.status).toBe(204);
	expect(await update.text()).toBe('');
	expect(await resources.dataSource.getRepository(MiRole).findOneByOrFail({ id: seed.roleId })).toMatchObject({ name: 'canonical-root-composed-role' });
	expect(await resources.dataSource.getRepository(MiModerationLog).countBy({ type: 'updateRole' })).toBe(auditCount + 1);
	const changed = await request('show', {});
	expect(changed.status).toBe(200);
	expect(await changed.json()).toMatchObject({ id: seed.roleId, name: 'canonical-root-composed-role' });
});
