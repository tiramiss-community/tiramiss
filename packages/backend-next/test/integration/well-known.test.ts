/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiMeta } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { wellKnownSource } from '../helpers/well-known-source.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let base: string;
const publicUrl = 'https://local.test:8443';
beforeAll(async () => {
	database = await createTestDatabase();
	database.config.url = publicUrl;
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('well-known-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

for (const sample of wellKnownSource.cases.filter(c => c.url === publicUrl && c.federation !== 'fault' && (c.method === 'OPTIONS' || !['/.well-known/oauth-authorization-server', '/.well-known/change-password'].includes(c.path)))) {
	test(`ordinary HTTP and persisted Meta match pinned ${sample.federation} ${sample.method} ${sample.path}`, async () => {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: sample.federation as 'all' | 'none' });
		await resources.meta.fetch(true);
		const response = await fetch(`${base}${sample.path}`, { method: sample.method, redirect: 'manual' });
		expect(response.status).toBe(sample.status);
		for (const [key, value] of Object.entries(sample.headers)) {
			if (sample.status !== 404 || key !== 'content-type') {
				expect(response.headers.get(key), key).toBe(value);
			}
		}
		if (sample.body !== null) {
			expect(await response.text()).toBe(sample.body);
		}
	});
}

test('warm Meta survives DB fault, cold host-meta fails, and wildcard OPTIONS bypasses Meta', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	await resources.meta.fetch(true);
	const cold = await connectResources(database.config, createLogger('well-known-cold-test', () => {}));
	const coldServer = await listenHttp(createBackendHttpApp(cold, database.config), { port: 0 });
	const coldBase = `http://127.0.0.1:${(coldServer.address() as { port: number }).port}`;
	await resources.dataSource.query('ALTER TABLE "meta" RENAME TO "well_known_fault_meta"');
	try {
		expect((await fetch(`${base}/.well-known/host-meta`)).status).toBe(200);
		await expect(resources.meta.fetch(true)).rejects.toThrow();
		for (const path of ['host-meta', 'host-meta.json']) {
			for (const method of ['GET', 'HEAD']) {
				const response = await fetch(`${coldBase}/.well-known/${path}`, { method });
				expect(response.status).toBe(500);
				expect(response.headers.get('access-control-allow-origin')).toBe('*');
				expect(response.headers.get('cache-control')).toBeNull();
				expect(response.headers.get('vary')).toBeNull();
				expect(await response.text()).toBe('');
			}
		}
		for (const path of ['host-meta', 'host-meta.json', 'missing', 'oauth-authorization-server', 'change-password', 'webfinger']) {
			const response = await fetch(`${coldBase}/.well-known/${path}`, { method: 'OPTIONS' });
			expect(response.status).toBe(204);
			expect(response.headers.get('access-control-allow-origin')).toBe('*');
			expect(await response.text()).toBe('');
		}
	} finally {
		await resources.dataSource.query('ALTER TABLE "well_known_fault_meta" RENAME TO "meta"');
		await closeHttp(coldServer);
		await cold.close();
	}
	expect((await fetch(`${base}/.well-known/host-meta.json`)).status).toBe(200);
});
