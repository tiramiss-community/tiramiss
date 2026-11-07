/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MiUserProfile, MiWebhook } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: ReturnType<typeof createServer>;
const requests: any[] = [];
let releaseResponse!: () => void;
const responseGate = new Promise<void>(resolve => {
	releaseResponse = resolve;
});

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
	await source.getRepository(MiUserProfile).insert({ userId: seeded.actors.ordinary.id, userHost: null });
	server = createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) {
			body += chunk;
		}
		requests.push({ headers: req.headers, body: JSON.parse(body) });
		await responseGate;
		res.writeHead(204).end();
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	await source.getRepository(MiWebhook).insert({ id: 'hook', userId: seeded.actors.ordinary.id, name: 'hook', active: true, on: ['note'], url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, secret: 'secret' });
});
afterAll(async () => {
	server?.close(); await source?.destroy(); await database?.close();
});

test('normal HTTP and worker processes deliver a created note and stop cleanly', async () => {
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port } });
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	try {
		await Promise.all([http.ready, worker.ready]);
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'webhook', localOnly: true }) });
		expect(response.status, await response.clone().text()).toBe(200);
		const note = (await response.json() as { createdNote: { id: string } }).createdNote;
		await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10000 });
		expect(requests[0].headers).toMatchObject({ 'user-agent': 'Misskey-Hooks', 'x-misskey-host': 'example.test', 'x-misskey-hook-id': 'hook', 'x-misskey-hook-secret': 'secret', 'content-type': 'application/json' });
		expect(requests[0].body).toMatchObject({ hookId: 'hook', type: 'note', body: { note: { id: note.id, text: 'webhook' } } });
		const deleted = await fetch(`http://127.0.0.1:${port}/api/notes/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, noteId: note.id }) });
		expect(deleted.status).toBe(204);
		http.child.kill('SIGTERM'); worker.child.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(worker.child.exitCode).toBeNull();
		releaseResponse();
		await vi.waitFor(async () => expect((await source.getRepository(MiWebhook).findOneByOrFail({ id: 'hook' })).latestStatus).toBe(204));
		expect(requests).toHaveLength(1);
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await worker.exit).code, worker.output()).toBe(0);
	} finally {
		releaseResponse(); await http.close(); await worker.close(); await config.close();
	}
});
