/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { gate, searchGateway } from '../helpers/search-gateway.js';
import type { DataSource } from 'typeorm';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize(); seeded = await seedRoleHttp(source);
});
afterAll(async () => {
	await source?.destroy(); await database?.close();
});

test.each(['PATCH', 'POST', 'DELETE'])('ordinary HTTP child drains accepted %s submission on SIGTERM without waiting for task application', async method => {
	const entered = gate(); const held = gate();
	const gateway = await searchGateway(async request => {
		if (request.method === method) {
			entered.release(); await held.promise;
		}
	});
	const port = await freePort();
	const config = await configuration({ ...database.config, fulltextSearch: { provider: 'meilisearch' }, meilisearch: gateway.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		if (method !== 'PATCH') {
			const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'child index', localOnly: true }) });
			expect(response.status, await response.clone().text()).toBe(200);
			const note = (await response.json() as { createdNote: { id: string } }).createdNote;
			if (method === 'DELETE') {
				await expect.poll(() => gateway.requests.filter(r => r.method === 'POST').length).toBe(1);
				const response = await fetch(`http://127.0.0.1:${port}/api/notes/delete`, { method: 'POST', body: JSON.stringify({ i: seeded.actors.ordinary.token, noteId: note.id }) });
				expect(response.status, await response.clone().text()).toBe(204);
			}
		}
		await entered.promise;
		let exited = false; void child.exit.then(() => {
			exited = true;
		});
		child.child.kill('SIGTERM');
		await expect.poll(async () => fetch(`http://127.0.0.1:${port}/health`, { headers: { Connection: 'close' } }).then(response => response.status === 503, () => true)).toBe(true);
		expect(exited).toBe(false);
		held.release();
		expect((await child.exit).code, child.output()).toBe(0);
		expect(gateway.requests.some(r => r.url.includes('/tasks'))).toBe(false);
	} finally {
		held.release(); await child.close(); await config.close(); await gateway.close();
	}
});

test('settings HTTP failure is logged without failing startup or ordinary saved HTTP response', async () => {
	const gateway = await searchGateway(async () => ({ status: 503, body: { message: 'injected', code: 'injected', type: 'internal', link: '' } }));
	const port = await freePort();
	const config = await configuration({ ...database.config, fulltextSearch: { provider: 'meilisearch' }, meilisearch: gateway.config, http: { port } });
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready;
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'engine unavailable', localOnly: true }) });
		expect(response.status).toBe(200);
		child.child.kill('SIGTERM'); expect((await child.exit).code, child.output()).toBe(0);
		expect(child.output()).toContain('search-settings.failed'); expect(child.output()).toContain('note-post-save.failed');
	} finally {
		await child.close(); await config.close(); await gateway.close();
	}
});

test('missing enabled configuration fails startup and a held settings request obeys the existing shutdown deadline', async () => {
	const port = await freePort();
	const missing = await configuration({ ...database.config, fulltextSearch: { provider: 'meilisearch' }, http: { port } });
	const rejected = launch('built/entrypoints/http.js', missing.path);
	try {
		expect((await rejected.exit).code).toBe(1); expect(rejected.output()).toContain('INVALID_CONFIG');
	} finally {
		await rejected.close(); await missing.close();
	}
	const held = gate(); const entered = gate();
	const gateway = await searchGateway(async () => {
		entered.release(); await held.promise;
	});
	const config = await configuration({ ...database.config, fulltextSearch: { provider: 'meilisearch' }, meilisearch: gateway.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 100 } });
	const child = launch('built/entrypoints/http.js', config.path);
	try {
		await child.ready; await entered.promise; child.child.kill('SIGTERM');
		expect((await child.exit).code, child.output()).toBe(1);
		expect(child.output()).toContain('shutdown.timeout');
	} finally {
		held.release(); await child.close(); await config.close(); await gateway.close();
	}
});
