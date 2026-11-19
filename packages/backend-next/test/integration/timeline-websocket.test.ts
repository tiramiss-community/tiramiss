/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MiBlocking, MiFollowing, MiMeta, MiMuting, MiNote, MiNoteReaction, MiRenoteMuting, MiRole, MiRoleAssignment, MiUserProfile } from 'backend-upstream/entities';
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
	for (const actor of [seed.actors.ordinary, seed.actors.root, seed.actors.administrator]) {
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
beforeEach(async () => {
	for (const socket of sockets) {
		socket.terminate();
	}
	await source.getRepository(MiMeta).update('singleton', { policies: {} });
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
			const start = messages.length;
			socket.send(JSON.stringify({ type: 'connect', body: { channel, id, params, pong: true } }));
			await vi.waitFor(() => expect(messages.slice(start)).toContainEqual({ type: 'connected', body: { id } }));
		},
	};
}

const channels = ['localTimeline', 'hybridTimeline', 'globalTimeline'];
const delivered = (client: { messages: any[] }, id: string) => client.messages.filter(message => message.body?.type === 'note' && message.body?.body?.id === id).map(message => message.body.id).sort();

async function post(input: Record<string, unknown> = {}) {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ i: seed.actors.ordinary.token, text: 'timeline note', localOnly: true, ...input }),
	});
	expect(response.status).toBe(200);
	await resources.notePostSave.idle();
	return ((await response.json()) as any).createdNote;
}

async function subscribeAll(token?: string) {
	const client = await connect(token);
	for (const channel of channels) {
		if (channel === 'hybridTimeline' && !token) {
			continue;
		}
		await client.channel(channel);
	}
	return client;
}

async function settle() {
	await new Promise(resolve => setTimeout(resolve, 50));
}

test('real HTTP producer delivers public and followers notes to self, guests, followed and unrelated viewers', async () => {
	const self = await subscribeAll(seed.actors.ordinary.token);
	const guest = await subscribeAll();
	const follower = await subscribeAll(seed.actors.root.token);
	const other = await subscribeAll(seed.actors.administrator.token);
	const publicNote = await post();
	await vi.waitFor(() => {
		for (const client of [self, follower, other]) {
			expect(delivered(client, publicNote.id)).toEqual([...channels].sort());
		}
		expect(delivered(guest, publicNote.id)).toEqual(['globalTimeline', 'localTimeline']);
	});
	const privateNote = await post({ visibility: 'followers' });
	await vi.waitFor(() => {
		expect(delivered(self, privateNote.id)).toEqual(['hybridTimeline']);
		expect(delivered(follower, privateNote.id)).toEqual(['hybridTimeline']);
	});
	await settle();
	expect(delivered(guest, privateNote.id)).toEqual([]);
	expect(delivered(other, privateNote.id)).toEqual([]);
	guest.socket.send(JSON.stringify({ type: 'connect', body: { id: 'denied', channel: 'hybridTimeline', pong: true } }));
	for (const params of [null, [], false, 'invalid']) {
		guest.socket.send(JSON.stringify({ type: 'connect', body: { id: 'invalid', channel: 'globalTimeline', params, pong: true } }));
	}
	await guest.channel('globalTimeline', 'barrier');
	expect(guest.messages.filter(message => message.type === 'connected').map(message => message.body.id)).toEqual(['localTimeline', 'globalTimeline', 'barrier']);
	for (const channel of ['localTimeline', 'globalTimeline', 'barrier']) {
		guest.socket.send(JSON.stringify({ type: 'disconnect', body: { id: channel } }));
	}
	await guest.channel('hashtag', 'disconnected-barrier', { q: [] });
	const after = await post();
	await vi.waitFor(() => expect(delivered(self, after.id)).toHaveLength(3));
	await settle();
	expect(delivered(guest, after.id)).toEqual([]);
	for (const client of [self, guest, follower, other]) {
		client.socket.terminate();
	}
});

test('real role policies gate guests and signed-in subscribers at each connect, including role overrides and expiry', async () => {
	await source.getRepository(MiMeta).update('singleton', { policies: { ltlAvailable: false, gtlAvailable: false } as never });
	const guest = await subscribeAll();
	const viewer = await subscribeAll(seed.actors.root.token);
	const roleId = seed.codec.newId(Date.now());
	const assignmentId = seed.codec.newId(Date.now());
	await source.getRepository(MiRole).insert({ id: roleId, name: 'timeline-allow', description: '', updatedAt: new Date(), lastUsedAt: new Date(), policies: { ltlAvailable: { value: true, priority: 2 }, gtlAvailable: { value: true, priority: 2 } } as never });
	await source.getRepository(MiRoleAssignment).insert({ id: assignmentId, roleId, userId: seed.actors.root.id });
	const self = await connect(seed.actors.ordinary.token);
	await source.getRepository(MiMeta).update('singleton', { policies: {} });
	await self.channel('globalTimeline');
	await source.getRepository(MiMeta).update('singleton', { policies: { ltlAvailable: false, gtlAvailable: false } as never });
	const before = await post();
	await vi.waitFor(() => expect(delivered(self, before.id)).toEqual(['globalTimeline']));
	await settle();
	expect(delivered(guest, before.id)).toEqual([]);
	expect(delivered(viewer, before.id)).toEqual([]);
	for (const channel of channels) {
		await viewer.channel(channel);
	}
	const allowed = await post();
	await vi.waitFor(() => expect(delivered(viewer, allowed.id)).toEqual([...channels].sort()));
	await source.getRepository(MiRoleAssignment).update(assignmentId, { expiresAt: new Date(0) });
	for (const channel of channels) {
		await viewer.channel(channel);
	}
	const expired = await post();
	await vi.waitFor(() => expect(delivered(self, expired.id)).toEqual(['globalTimeline']));
	await settle();
	expect(delivered(viewer, expired.id)).toEqual([]);
	await source.getRepository(MiMeta).update('singleton', { policies: {} });
	for (const client of [guest, viewer, self]) {
		client.socket.terminate();
	}
});

test('real relationship rows suppress muted, blocked and renote-muted producers and populate each viewers reaction', async () => {
	const self = await subscribeAll(seed.actors.ordinary.token);
	for (const kind of ['mute', 'block', 'renote-mute'] as const) {
		const id = seed.codec.newId(Date.now());
		if (kind === 'mute') {
			await source.getRepository(MiMuting).insert({ id, muterId: seed.actors.root.id, muteeId: seed.actors.ordinary.id });
		}
		if (kind === 'block') {
			await source.getRepository(MiBlocking).insert({ id, blockerId: seed.actors.ordinary.id, blockeeId: seed.actors.root.id });
		}
		if (kind === 'renote-mute') {
			await source.getRepository(MiRenoteMuting).insert({ id, muterId: seed.actors.root.id, muteeId: seed.actors.ordinary.id });
		}
		const viewer = await subscribeAll(seed.actors.root.token);
		const original = await post();
		const published = kind === 'renote-mute' ? await post({ text: null, renoteId: original.id }) : original;
		await vi.waitFor(() => expect(delivered(self, published.id)).toHaveLength(3));
		await settle();
		expect(delivered(viewer, published.id)).toEqual([]);
		viewer.socket.terminate();
		if (kind === 'mute') {
			await source.getRepository(MiMuting).delete(id);
		}
		if (kind === 'block') {
			await source.getRepository(MiBlocking).delete(id);
		}
		if (kind === 'renote-mute') {
			await source.getRepository(MiRenoteMuting).delete(id);
		}
	}
	const viewer = await subscribeAll(seed.actors.root.token);
	const guest = await subscribeAll();
	const original = await post();
	await source.getRepository(MiNoteReaction).insert({ id: seed.codec.newId(Date.now()), userId: seed.actors.root.id, noteId: original.id, reaction: '👍' });
	await source.getRepository(MiNote).update(original.id, { reactions: { '👍': 1 } as never, reactionAndUserPairCache: [seed.actors.root.id + '/👍'] });
	const renote = await post({ text: null, renoteId: original.id });
	await vi.waitFor(() => {
		for (const client of [viewer, guest]) {
			expect(delivered(client, renote.id)).toHaveLength(client === guest ? 2 : 3);
		}
	});
	for (const message of viewer.messages.filter(message => message.body?.body?.id === renote.id)) {
		expect(message.body.body.renote.myReaction).toBe('👍');
	}
	for (const message of guest.messages.filter(message => message.body?.body?.id === renote.id)) {
		expect(message.body.body.renote.myReaction).toBeUndefined();
	}
	for (const client of [self, viewer, guest]) {
		client.socket.terminate();
	}
});

test('real producer preserves reply, file, renote and remote routing options for independent subscriptions', async () => {
	const viewer = await subscribeAll(seed.actors.root.token);
	for (const channel of channels) {
		await viewer.channel(channel, `${channel}-files`, { withFiles: true });
		await viewer.channel(channel, `${channel}-no-renotes`, { withRenotes: false });
		if (channel !== 'globalTimeline') {
			await viewer.channel(channel, `${channel}-replies`, { withReplies: true });
		}
	}
	const target = await post({ i: seed.actors.administrator.token });
	const reply = await post({ replyId: target.id });
	await vi.waitFor(() => expect(delivered(viewer, reply.id)).toEqual(['globalTimeline', 'globalTimeline-no-renotes', 'hybridTimeline-replies', 'localTimeline-replies']));
	const original = await post();
	const renote = await post({ text: null, renoteId: original.id });
	await vi.waitFor(() => expect(delivered(viewer, renote.id)).toEqual(['globalTimeline', 'hybridTimeline', 'hybridTimeline-replies', 'localTimeline', 'localTimeline-replies']));
	const quote = await post({ text: 'quote', renoteId: original.id });
	await vi.waitFor(() => expect(delivered(viewer, quote.id)).toHaveLength(8));
	const publisher = createPostingStream(resources.redis, database.config.url);
	const remote = { ...original, id: 'remote-snapshot', user: { ...original.user, host: 'remote.example' } };
	await publisher.notes(remote);
	await vi.waitFor(() => expect(delivered(viewer, remote.id)).toEqual(['globalTimeline', 'globalTimeline-no-renotes', 'hybridTimeline', 'hybridTimeline-no-renotes', 'hybridTimeline-replies']));
	const file = { ...original, id: 'file-snapshot', fileIds: ['existing-published-file'] };
	await publisher.notes(file);
	await vi.waitFor(() => expect(delivered(viewer, file.id)).toHaveLength(11));
	viewer.socket.terminate();
});
