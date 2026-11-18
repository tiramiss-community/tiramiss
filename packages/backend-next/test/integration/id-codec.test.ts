/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiDriveFolder, MiMeta, MiUser } from 'backend-upstream/entities';
import { loadConfig } from '../../src/config/load-config.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { idMethods } from '../../src/platform/id-codec.js';
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

test.for(idMethods)('YAML %s selection survives HTTP generation, PostgreSQL storage and fresh HTTP read', async (method, context) => {
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
	const active = new Set<Promise<unknown>>();
	const listener = getRequestListener(app.fetch);
	let draining = false;
	const server = createServer((request, response) => {
		if (draining) {
			response.writeHead(503, { Connection: 'close' });
			response.end();
			return;
		}
		const handling = Promise.resolve(listener(request, response));
		active.add(handling);
		void handling.then(() => active.delete(handling), error => {
			active.delete(handling);
			response.destroy(error instanceof Error ? error : undefined);
		});
	});
	const requests = new AbortController();
	let restoreClock = () => {};
	context.onTestFinished(async () => {
		restoreClock();
		requests.abort();
		draining = true;
		const closed = server.listening ? new Promise<void>((resolve, reject) => {
			server.close(error => error ? reject(error) : resolve());
		}) : Promise.resolve();
		server.closeAllConnections();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const results = await Promise.race([
				Promise.allSettled([
					closed,
					Promise.allSettled([...active]).then(() => drainHttpAppWork(app)),
				]),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('ID_HTTP_CLEANUP_TIMEOUT')), 15000);
				}),
			]);
			const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
			if (failures.length) {
				throw new AggregateError(failures, 'ID_HTTP_CLEANUP_FAILED');
			}
		} finally {
			clearTimeout(timer);
		}
	}, 20000);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	expect((server.address() as { address: string }).address).toBe('127.0.0.1');
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const call = (operation: string, body: object) => fetch(`${url}/api/drive/folders/${operation}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
		signal: AbortSignal.any([context.signal, requests.signal, AbortSignal.timeout(10000)]),
	});
	const clock = vi.spyOn(Date, 'now').mockReturnValue(fixture.now);
	restoreClock = () => clock.mockRestore();
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
});
