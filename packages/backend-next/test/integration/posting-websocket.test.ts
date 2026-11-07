/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MiAccessToken, MiApp, MiFollowing, MiMuting, MiNote, MiNoteReaction, MiUser, MiUserProfile } from 'backend-upstream/entities';
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
	await source.getRepository(MiFollowing).insert({ id: seed.codec.newId(Date.now()), followerId: seed.actors.root.id, followeeId: seed.actors.ordinary.id });
	resources = await createRuntime(database.config);
	server = await listenHttp(createBackendHttpApp(resources, database.config), database.config.http);
	wsServer = await openPostingWebSocket(server, resources, database.config, error => {
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
	socket.on('message', data => messages.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => {
 socket.once('open', resolve); socket.once('error', reject); 
});
	return { socket, messages, async channel(channel: string, id = channel) {
		socket.send(JSON.stringify({ type: 'connect', body: { channel, id, pong: true } }));
		await vi.waitFor(() => expect(messages).toContainEqual({ type: 'connected', body: { id } }));
	} };
}

async function rejection(token?: string, headers?: Record<string, string>) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/streaming${token ? `?i=${token}` : ''}`, { headers });
	sockets.push(socket);
	socket.on('error', () => {});
	return new Promise<{ status: number; challenge: string | undefined }>(resolve => {
		socket.on('unexpected-response', (_req, res) => {
 res.resume(); socket.terminate(); resolve({ status: res.statusCode!, challenge: res.headers['www-authenticate'] }); 
});
	});
}

test('native/app grants, suspension and case-sensitive Bearer priority are checked before upgrade', async () => {
	const invalid = await rejection('invalid');
	expect(invalid).toMatchObject({ status: 401, challenge: 'Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"' });
	expect((await rejection(seed.actors.ordinaryNoScope.token)).status).toBe(401);
	expect((await rejection(seed.actors.suspended.token)).status).toBe(403);
	expect((await rejection(seed.actors.ordinary.token, { Authorization: 'Bearer invalid' })).status).toBe(401);
	const native = await connect('invalid', { Authorization: `Bearer ${seed.actors.ordinary.token}` });
	await native.channel('main');
	const lowercase = await connect(seed.actors.ordinary.token, { Authorization: 'bearer invalid' });
	await lowercase.channel('main');
	await source.getRepository(MiApp).update({ name: 'probe' }, { permission: ['read:account'] });
	const app = await connect(seed.actors.appRead.token);
	await app.channel('main');
	await source.getRepository(MiAccessToken).insert({ id: seed.codec.newId(Date.now()), userId: seed.actors.root.id, token: 'miauth-streaming-120', hash: 'stream-miauth-hash', permission: ['read:account'] });
	await (await connect('miauth-streaming-120')).channel('homeTimeline');
	await connect();
});

test('real HTTP create/delete reaches following home and named main, never another main or guest', async () => {
	const root = await connect(seed.actors.root.token);
	const author = await connect(seed.actors.ordinary.token);
	const guest = await connect();
	await root.channel('main');
	await root.channel('homeTimeline');
	await author.channel('main');
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: seed.actors.ordinary.token, text: '@root websocket snapshot', visibility: 'followers' }) });
	expect(response.status).toBe(200);
	const id = ((await response.json()) as any).createdNote.id;
	await vi.waitFor(() => {
		expect(root.messages.some(m => m.body?.type === 'note' && m.body.body.id === id)).toBe(true);
		expect(root.messages.some(m => m.body?.type === 'mention' && m.body.body.id === id)).toBe(true);
		expect(root.messages.some(m => m.body?.type === 'notification' && m.body.body.note?.id === id)).toBe(true);
	});
	expect(author.messages.filter(m => m.body?.type === 'mention')).toEqual([]);
	expect(guest.messages).toEqual([]);
	root.socket.send(JSON.stringify({ type: 'subNote', body: { id } }));
	guest.socket.send(JSON.stringify({ type: 's', body: { id } }));
	// A channel acknowledgement is a FIFO barrier after the subscription request.
	await root.channel('homeTimeline', 'barrier');
	const deleted = await fetch(`http://127.0.0.1:${port}/api/notes/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: seed.actors.ordinary.token, noteId: id }) });
	expect(deleted.status).toBe(204);
	await vi.waitFor(() => expect(root.messages.find(m => m.type === 'noteUpdated')).toMatchObject({ body: { id, type: 'deleted', body: { deletedAt: expect.any(String) } } }));
	expect(root.messages.find(m => m.type === 'noteUpdated').body).not.toHaveProperty('userId');
	expect(guest.messages).toEqual([]);
});

test('two real receivers preserve published nested snapshots and get isolated hiding and own reactions', async () => {
	const root = await connect(seed.actors.root.token);
	const author = await connect(seed.actors.ordinary.token);
	await root.channel('homeTimeline');
	await author.channel('homeTimeline');
	const targetId = seed.codec.newId(Date.now() - 10000);
	await source.getRepository(MiNote).insert({ id: targetId, userId: seed.actors.root.id, text: 'current database text', visibility: 'public' });
	await source.getRepository(MiNoteReaction).insert({ id: seed.codec.newId(Date.now()), userId: seed.actors.root.id, noteId: targetId, reaction: 'love' });
	const target = { id: targetId, userId: seed.actors.root.id, user: { id: seed.actors.root.id, host: null }, createdAt: new Date(Date.now() - 10000).toISOString(), text: 'published snapshot text', cw: null, fileIds: [], files: [], visibility: 'public', reactions: { '❤': 1 } };
	const outer = { ...target, id: 'published-pure', userId: seed.actors.ordinary.id, user: { id: seed.actors.ordinary.id, host: null }, text: null, renoteId: targetId, renote: target };
	const publisher = createPostingStream(resources.redis, database.config.url);
	await publisher.notes(outer);
	await vi.waitFor(() => {
		expect(root.messages.find(m => m.body?.body?.id === outer.id)?.body.body.renote).toMatchObject({ text: 'published snapshot text', myReaction: '❤' });
		expect(author.messages.find(m => m.body?.body?.id === outer.id)?.body.body.renote.text).toBe('published snapshot text');
	});
	expect(author.messages.find(m => m.body?.body?.id === outer.id).body.body.renote).not.toHaveProperty('myReaction');
	await publisher.notes({ ...outer, id: 'published-quote', text: 'quote', renote: { ...target, visibility: 'specified', visibleUserIds: [seed.actors.root.id] } });
	await vi.waitFor(() => {
		expect(root.messages.find(m => m.body?.body?.id === 'published-quote')?.body.body.renote.text).toBe('published snapshot text');
		expect(author.messages.find(m => m.body?.body?.id === 'published-quote')?.body.body.renote).toMatchObject({ isHidden: true, text: null });
	});
	expect(target.text).toBe('published snapshot text');
});

test('activity wakes the user/following flags and refreshed facts suppress a newly muted sender', async () => {
	await source.getRepository(MiUser).update(seed.actors.root.id, { isHibernated: true, lastActiveDate: new Date(0) });
	await source.getRepository(MiFollowing).update({ followerId: seed.actors.root.id }, { isFollowerHibernated: true });
	const root = await connect(seed.actors.root.token);
	await root.channel('main');
	await vi.waitFor(async () => {
		expect(await source.getRepository(MiUser).findOneByOrFail({ id: seed.actors.root.id })).toMatchObject({ isHibernated: false, lastActiveDate: expect.any(Date) });
		expect(await source.getRepository(MiFollowing).findOneByOrFail({ followerId: seed.actors.root.id, followeeId: seed.actors.ordinary.id })).toMatchObject({ isFollowerHibernated: false });
	});
	await source.getRepository(MiMuting).insert({ id: seed.codec.newId(Date.now()), muterId: seed.actors.root.id, muteeId: seed.actors.ordinary.id });
	await new Promise(resolve => setTimeout(resolve, 10500));
	const publisher = createPostingStream(resources.redis, database.config.url);
	await publisher.main(seed.actors.root.id, 'notification', { id: 'muted', userId: seed.actors.ordinary.id });
	await publisher.main(seed.actors.root.id, 'reply', { id: 'after-muted' });
	await vi.waitFor(() => expect(root.messages.some(m => m.body?.body?.id === 'after-muted')).toBe(true));
	expect(root.messages.some(m => m.body?.body?.id === 'muted')).toBe(false);
});

test('deleted hidden main roots are skipped while the same WS client receives later queued events', async () => {
	const root = await connect(seed.actors.root.token);
	await root.channel('main');
	const publisher = createPostingStream(resources.redis, database.config.url);
	const note = { id: seed.codec.newId(Date.now()), userId: seed.actors.root.id, user: { id: seed.actors.root.id, host: null }, visibility: 'public', text: null, isHidden: true };
	await publisher.main(seed.actors.root.id, 'notification', { id: 'deleted-hidden-notification', type: 'mention', userId: seed.actors.root.id, note });
	await publisher.main(seed.actors.root.id, 'mention', note);
	const later = { ...note, id: 'later-visible-snapshot', text: 'later', isHidden: false };
	await publisher.main(seed.actors.root.id, 'mention', later);
	await vi.waitFor(() => expect(root.messages).toContainEqual({ type: 'channel', body: { id: 'main', type: 'mention', body: later } }));
	expect(root.messages.filter(m => m.type === 'channel')).toEqual([{ type: 'channel', body: { id: 'main', type: 'mention', body: later } }]);
});
