/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { MiFollowing, MiUserProfile } from 'backend-upstream/entities';
import { createTestDatabase } from '../helpers/database.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { configuration, freePort, launch } from '../helpers/process.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seed = await seedRoleHttp(source);
	await source.getRepository(MiUserProfile).insert([{ userId: seed.actors.root.id }, { userId: seed.actors.ordinary.id }]);
	await source.getRepository(MiFollowing).insert({ id: seed.codec.newId(Date.now()), followerId: seed.actors.root.id, followeeId: seed.actors.ordinary.id });
});
afterAll(async () => {
 await source?.destroy(); await database?.close(); 
});

async function websocket(port: number, token: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/streaming?i=${token}`);
	const messages: any[] = [];
	socket.on('message', data => messages.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => {
 socket.once('open', resolve); socket.once('error', reject); 
});

	async function channel(name: string, id = name) {
		socket.send(JSON.stringify({ type: 'connect', body: { id, channel: name, pong: true } }));
		await vi.waitFor(() => expect(messages).toContainEqual({ type: 'connected', body: { id } }));
	}

	return { socket, messages, channel };
}

test('normal HTTP and worker processes deliver create/main/home, deletion and ended-poll WS before SIGTERM closes connected clients', async () => {
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } });
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	let viewer: Awaited<ReturnType<typeof websocket>> | undefined;
	let author: Awaited<ReturnType<typeof websocket>> | undefined;
	let reconnected: Awaited<ReturnType<typeof websocket>> | undefined;
	try {
		await Promise.all([http.ready, worker.ready]);
		viewer = await websocket(port, seed.actors.root.token);
		author = await websocket(port, seed.actors.ordinary.token);
		await viewer.channel('main');
		await viewer.channel('homeTimeline');
		await author.channel('main');
		const create = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: seed.actors.ordinary.token, text: '@root real process', poll: { choices: ['a', 'b'], expiredAfter: 1500 } }) });
		expect(create.status).toBe(200);
		const id = ((await create.json()) as any).createdNote.id;
		await vi.waitFor(() => {
			for (const type of ['note', 'mention', 'notification']) {
				expect(viewer!.messages.some(m => m.body?.type === type && (m.body.body.id === id || m.body.body.note?.id === id))).toBe(true);
			}
		}, { timeout: 10000 });
		await vi.waitFor(() => expect(author!.messages.some(m => m.body?.type === 'notification' && m.body.body.type === 'pollEnded' && m.body.body.note?.id === id)).toBe(true), { timeout: 10000 });
		expect(await source.query('SELECT notification_type FROM backend_internal.notification WHERE note_id = $1 ORDER BY notification_type', [id])).toEqual([{ notification_type: 'mention' }, { notification_type: 'pollEnded' }]);
		viewer.socket.send(JSON.stringify({ type: 'sr', body: { id } }));
		await viewer.channel('homeTimeline', 'subscription-barrier');
		const deleted = await fetch(`http://127.0.0.1:${port}/api/notes/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: seed.actors.ordinary.token, noteId: id }) });
		expect(deleted.status).toBe(204);
		await vi.waitFor(() => expect(viewer!.messages.find(m => m.type === 'noteUpdated')).toEqual({ type: 'noteUpdated', body: { id, type: 'deleted', body: { deletedAt: expect.any(String) } } }));
		viewer.socket.close();
		await new Promise<void>(resolve => viewer!.socket.once('close', () => resolve()));
		reconnected = await websocket(port, seed.actors.root.token);
		await reconnected.channel('homeTimeline');
		const closed = new Promise<void>(resolve => reconnected!.socket.once('close', () => resolve()));
		http.child.kill('SIGTERM');
		worker.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await worker.exit).code, worker.output()).toBe(0);
		await closed;
		for (const output of [http.output(), worker.output()]) {
			expect(output).not.toMatch(/streaming\.operation\.failed|streaming\.event\.failed|note-post-save.failed|job.failed|SHUTDOWN_TIMEOUT/);
		}
	} finally {
		viewer?.socket.terminate(); author?.socket.terminate(); reconnected?.socket.terminate();
		await http.close(); await worker.close(); await config.close();
	}
});

test('a reset during asynchronous upgrade authentication cannot crash the HTTP process', async () => {
	const result = await promisify(execFile)(process.execPath, ['test/fixtures/streaming-reset.mjs']);
	expect(JSON.parse(result.stdout)).toEqual({ uncaughtDuringAuthentication: [] });
});
