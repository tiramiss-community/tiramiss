/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MiFollowing, MiUserProfile } from 'backend-upstream/entities';
import { createTestDatabase } from '../helpers/database.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { createRuntime } from '../../src/composition/create-runtime.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { openPostingWebSocket } from '../../src/composition/posting-websocket.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { createPostingStream } from '../../src/platform/posting-stream.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let resources: Awaited<ReturnType<typeof createRuntime>>;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: Server;
let wsServer: Awaited<ReturnType<typeof openPostingWebSocket>>;
let port: number;
const sockets: WebSocket[] = [];
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seed = await seedRoleHttp(source);
	for (const actor of [seed.actors.ordinary, seed.actors.root]) {
		await source.getRepository(MiUserProfile).insert({ userId: actor.id });
	}
	await source
		.getRepository(MiFollowing)
		.insert({ id: seed.codec.newId(Date.now()), followerId: seed.actors.root.id, followeeId: seed.actors.ordinary.id });
	resources = await createRuntime(database.config);
	server = await listenHttp(createBackendHttpApp(resources, database.config), database.config.http);
	wsServer = await openPostingWebSocket(server, resources, database.config, (error) => {
		throw error;
	});
	port = (server.address() as { port: number }).port;
});
afterAll(async () => {
	for (const socket of sockets) {
		socket.terminate();
	}
	await wsServer?.close();
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await source?.destroy();
	await database?.close();
});

async function connect(token?: string, headers?: Record<string, string>) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/streaming${token ? `?i=${token}` : ''}`, { headers });
	sockets.push(socket);
	const messages: any[] = [];
	socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => {
		socket.once('open', resolve);
		socket.once('error', reject);
	});
	return {
		socket,
		messages,
		async channel(channel: string, id = channel, params: Record<string, unknown> = {}) {
			socket.send(JSON.stringify({ type: 'connect', body: { channel, id, params, pong: true } }));
			await vi.waitFor(() => expect(messages).toContainEqual({ type: 'connected', body: { id } }));
		},
	};
}

test('real HTTP posts route hashtag notes to matching guest and authenticated WebSockets and stop after disconnect', async () => {
	const guest = await connect();
	const viewer = await connect(seed.actors.root.token);
	await guest.channel('hashtag', 'matching', { q: [['ＭＩＳＳＫＥＹ', 'stream'], ['other']] });
	await guest.channel('hashtag', 'unmatched', { q: [['absent']] });
	await viewer.channel('hashtag', 'authenticated', { q: [['misskey']] });

	async function post(text: string, visibility = 'public') {
		const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: seed.actors.ordinary.token, text, visibility }),
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as any).createdNote.id as string;
	}

	const id = await post('hashtag #Misskey #stream');
	await vi.waitFor(() => {
		expect(guest.messages).toContainEqual(
			expect.objectContaining({
				body: expect.objectContaining({ id: 'matching', type: 'note', body: expect.objectContaining({ id }) }),
			}),
		);
		expect(viewer.messages).toContainEqual(
			expect.objectContaining({
				body: expect.objectContaining({ id: 'authenticated', type: 'note', body: expect.objectContaining({ id }) }),
			}),
		);
	});
	expect(guest.messages.filter((message) => message.body?.id === 'unmatched' && message.body?.type === 'note')).toEqual(
		[],
	);
	const privateId = await post('private #misskey #stream', 'followers');
	await vi.waitFor(() => expect(viewer.messages.some((message) => message.body?.body?.id === privateId)).toBe(true));
	expect(guest.messages.some((message) => message.body?.body?.id === privateId)).toBe(false);
	guest.socket.send(
		JSON.stringify({ type: 'connect', body: { id: 'invalid', channel: 'hashtag', params: { q: [[]] }, pong: true } }),
	);
	guest.socket.send(JSON.stringify({ type: 'disconnect', body: { id: 'matching' } }));
	await guest.channel('hashtag', 'barrier', { q: [['barrier']] });
	expect(guest.messages.some((message) => message.type === 'connected' && message.body?.id === 'invalid')).toBe(false);
	const after = await post('after disconnect #misskey #stream');
	await vi.waitFor(() => expect(viewer.messages.some((message) => message.body?.body?.id === after)).toBe(true));
	expect(guest.messages.some((message) => message.body?.body?.id === after)).toBe(false);
	const publisher = createPostingStream(resources.redis, database.config.url);
	await publisher.main(seed.actors.root.id, 'reply', { id: 'unrelated' });
	const barrier = await post('last #misskey #stream');
	await vi.waitFor(() => expect(viewer.messages.some((message) => message.body?.body?.id === barrier)).toBe(true));
	expect(viewer.messages.some((message) => message.body?.body?.id === 'unrelated')).toBe(false);
});
