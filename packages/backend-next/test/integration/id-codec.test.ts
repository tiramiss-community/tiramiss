/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiDriveFolder, MiMeta, MiUser } from 'backend-upstream/entities';
import { loadConfig } from '../../src/config/load-config.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { idMethods } from '../../src/platform/id-codec.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import observations from '../../../../docs/superpowers/compatibility/id-codec/observations.json' with { type: 'json' };

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let directory: string;
const token = 'idcodec000000000';
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'id-codec-config-'));
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('id-codec-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	await resources.dataSource.getRepository(MiUser).insert({ id: 'alice', username: 'alice', usernameLower: 'alice', token });
});
afterAll(async () => {
	try {
		await resources?.close();
	} finally {
		try {
			await database?.close();
		} finally {
			if (directory) {
				await rm(directory, { recursive: true, force: true });
			}
		}
	}
});

test.each(idMethods)('YAML %s selection survives HTTP generation, PostgreSQL storage and fresh HTTP read', async method => {
	const fixture = observations.cases.find(item => item.method === method && item.label === 'now')!;
	const db = database.config.database;
	const file = join(directory, `${method}.yml`);
	await writeFile(file, JSON.stringify({
		url: database.config.url, port: 3000, id: method.toUpperCase(),
		db: { host: db.host, port: db.port, db: db.database, user: db.username, pass: db.password },
		redis: database.config.redis,
	}));
	const config = await loadConfig({ configFile: file, env: {} });
	expect(config.id).toBe(method);
	const app = createBackendHttpApp(resources, config);
	const server = await listenHttp(app, { port: 0 });
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const call = (operation: string, body: object) => fetch(`${url}/api/drive/folders/${operation}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
	});
	const clock = vi.spyOn(Date, 'now').mockReturnValue(fixture.now);
	try {
		const created = await call('create', { name: `folder-${method}` });
		expect(created.status).toBe(200);
		const body = await created.json();
		expect(body.id).toHaveLength(fixture.generated!.length);
		expect(body.id.startsWith(fixture.generated!.prefix)).toBe(true);
		expect(body.createdAt).toBe(new Date(fixture.parsedAt!).toISOString());
		const saved = await resources.dataSource.getRepository(MiDriveFolder).findOneByOrFail({ id: body.id });
		expect(saved).toMatchObject({ id: body.id, name: `folder-${method}`, userId: 'alice' });
		const response = await call('show', { folderId: saved.id });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: saved.id, name: saved.name, createdAt: body.createdAt });
	} finally {
		clock.mockRestore();
		try {
			await closeHttp(server);
		} finally {
			await drainHttpAppWork(app);
		}
	}
});
