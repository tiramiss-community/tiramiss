/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiDriveFile, MiEmoji, MiMeta, MiNote, MiPoll, MiUser, MiUserKeypair, MiUserNotePining, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { createLogger } from '../../src/platform/logger.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { featuredCorpus, featuredSource } from '../helpers/local-featured.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let port: number;
const note = featuredCorpus.defaults.note;
const replyId = 'at3hjq77note0002';
const innerId = 'at3hjq77note0003';
const get = (path: string, accept = 'application/activity+json', method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Accept: accept }, redirect: 'manual' });
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = 'https://local.example';
	resources = await connectResources(database.config, createLogger('local-featured-test', () => { }));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	await resources.dataSource.getRepository(MiUser).insert({ id: 'alice', username: 'alice', usernameLower: 'alice' });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: 'alice' });
	const key = await generateRsaKeyPair();
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: 'alice', publicKey: key.publicKeyPem, privateKey: key.privateKeyPem });
	await resources.dataSource.getRepository(MiNote).insert([{ ...note, id: innerId, text: 'inner' }, { ...note, id: replyId, text: 'reply', replyId: innerId }, { ...note, replyId }]);
	await resources.dataSource.getRepository(MiUserNotePining).insert([{ id: 'pin002', userId: 'alice', noteId: note.id }, { id: 'pin001', userId: 'alice', noteId: innerId }]);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	port = (server.address() as {
		port: number;
	}).port;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});
test('actor featured URL → saved pins → linked Note GET uses distinct reply depths and preserves rows', async () => {
	const before = await resources.dataSource.getRepository(MiUserNotePining).find({ order: { id: 'DESC' } });
	const actor = await (await get('/users/alice')).json() as {
		featured: string;
	};
	expect(actor.featured).toBe('https://local.example/users/alice/collections/featured');
	const response = await get(new URL(actor.featured).pathname);
	expect(response.status).toBe(200);
	const body = await response.json() as {
		orderedItems: {
			id: string;
			inReplyTo: {
				id: string;
				inReplyTo: string;
			} | null;
		}[];
		totalItems: number;
	};
	expect(body.totalItems).toBe(2);
	expect(body.orderedItems.map(n => n.id)).toEqual([`https://local.example/notes/${note.id}`, `https://local.example/notes/${innerId}`]);
	expect(body.orderedItems[0].inReplyTo).toMatchObject({ id: `https://local.example/notes/${replyId}`, inReplyTo: `https://local.example/notes/${innerId}` });
	const linked = await get(new URL(body.orderedItems[0].id).pathname);
	expect(linked.status).toBe(200);
	expect(await linked.json()).toMatchObject({ id: body.orderedItems[0].id, inReplyTo: `https://local.example/notes/${replyId}` });
	expect(await resources.dataSource.getRepository(MiUserNotePining).find({ order: { id: 'DESC' } })).toEqual(before);
});
test.each(['GET', 'HEAD'])('%s keeps Accept, cache and CORS on both public paths', async (method) => {
	for (const path of ['/users/alice/collections/featured', `/notes/${note.id}`]) {
		const response = await get(path, 'application/ld+json', method);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('public, max-age=180');
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(response.headers.get('vary')).toBe(path.startsWith('/notes/') ? 'Accept' : null);
		if (method === 'HEAD') {
			expect(await response.text()).toBe('');
		}
	}
});
test('HTML remains outside AP while featured accepts HTML; source featured does not suppress a suspended user', async () => {
	expect((await get(`/notes/${note.id}`, 'text/html')).status).toBe(404);
	expect((await get('/users/alice/collections/featured', 'text/html')).status).toBe(200);
	await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: true });
	try {
		expect((await get('/users/alice')).status).toBe(404);
		expect((await get('/users/alice/collections/featured')).status).toBe(200);
	} finally {
		await resources.dataSource.getRepository(MiUser).update('alice', { isSuspended: false });
	}
});
test('disabled federation precedes missing rows and public eligibility filters Note and collection', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
	try {
		for (const path of ['/users/gone/collections/featured', '/notes/gone']) {
			expect((await get(path)).status).toBe(403);
		}
	} finally {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	}
	for (const change of [{ visibility: 'followers' as const }, { visibility: 'specified' as const }, { localOnly: true }]) {
		await resources.dataSource.getRepository(MiNote).update(note.id, change);
		try {
			expect((await get(`/notes/${note.id}`)).status).toBe(404);
			expect(await (await get('/users/alice/collections/featured')).json()).toMatchObject({ totalItems: 1 });
		} finally {
			await resources.dataSource.getRepository(MiNote).update(note.id, { visibility: 'public', localOnly: false });
		}
	}
});
test.each([
	{ userHost: 'remote.test', uri: 'https://remote.test/note', status: 302 },
	{ userHost: 'remote.test', uri: null, status: 500 },
	{ userHost: 'local.example', uri: 'https://remote.test/note', status: 500 },
])('stored remote Note $userHost $uri has source routing before hydration', async (c) => {
	await resources.dataSource.getRepository(MiNote).update(note.id, { userHost: c.userHost, uri: c.uri });
	try {
		const response = await get(`/notes/${note.id}`);
		expect(response.status).toBe(c.status);
		expect(response.headers.get('location')).toBe(c.status === 302 ? c.uri : null);
	} finally {
		await resources.dataSource.getRepository(MiNote).update(note.id, { userHost: null, uri: null });
	}
});
test('synchronized pin Entity uses existing migrations and passes scoped schema check without history rewrite', async () => {
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	expect(resources.dataSource.getMetadata(MiUserNotePining).tableName).toBe('user_note_pining');
	const history = await resources.dataSource.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id');
	await migrateDatabase(database.config.database);
	expect(await resources.dataSource.query('SELECT id, timestamp, name FROM public.migrations ORDER BY id')).toEqual(history);
});
test('stored redirect policy rejects external AP lookup with canonical link while bare LD remains a redirect', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { allowExternalApRedirect: false });
	await resources.dataSource.getRepository(MiNote).update(note.id, { userHost: 'remote.test', uri: 'https://remote.test/note' });
	try {
		const response = await get(`/notes/${note.id}`);
		expect(response.status).toBe(406);
		expect(response.headers.get('location')).toBeNull();
		expect(response.headers.get('link')).toBe('<https://remote.test/note>; rel="canonical"');
		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect((await get(`/notes/${note.id}`, 'application/ld+json')).status).toBe(302);
	} finally {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { allowExternalApRedirect: true });
		await resources.dataSource.getRepository(MiNote).update(note.id, { userHost: null, uri: null });
	}
});
test('a pin target retrieval failure never becomes a partial successful collection', async () => {
	const repository = resources.dataSource.getRepository(MiNote);
	const original = repository.findOneByOrFail.bind(repository);
	const fault = vi.spyOn(repository, 'findOneByOrFail').mockImplementation(async (query) => {
		if ('id' in query && query.id === innerId) {
			throw Error('target disappeared during retrieval');
		}
		return original(query);
	});
	try {
		const response = await get('/users/alice/collections/featured');
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBeNull();
	} finally {
		fault.mockRestore();
	}
});
// New publication hydration must retain the same stored media, poll, emoji and quote semantics as delivery.
test('rich stored Note publication matches independent literal-source JSON', async () => {
	const c = featuredCorpus.cases.find(row => row.id === 'rich')!;
	const file = c.files![0];
	const emoji = c.emojis![0];
	const hiddenEmoji = c.emojis![1];
	const manager = resources.dataSource.manager;
	await manager.getRepository(MiUser).insert({ id: 'remote', username: 'bob', usernameLower: 'bob', host: 'remote.test', uri: 'https://remote.test/users/bob' });
	await manager.getRepository(MiDriveFile).insert({ ...file, userId: 'alice', name: 'image.png', md5: '0'.repeat(32), size: 1, storedInternal: false });
	await manager.getRepository(MiEmoji).insert([emoji, hiddenEmoji].map((e, i) => ({ ...e, id: `featuredemoji${i}`, host: null, updatedAt: e.updatedAt === null ? null : new Date(e.updatedAt) })));
	await manager.getRepository(MiPoll).insert({ noteId: note.id, userId: 'alice', userHost: null, noteVisibility: 'public', choices: c.poll!.choices, votes: c.poll!.votes, multiple: c.poll!.multiple, expiresAt: new Date(c.poll!.expiresAt!) });
	await manager.getRepository(MiNote).update(note.id, { ...c.note, replyId: null });
	try {
		const response = await get(`/notes/${note.id}`);
		expect(response.status).toBe(200);
		const json = await response.json() as Record<string, unknown>;
		const { ['@context']: context, ...rendered } = json;
		expect(context).toContain('https://www.w3.org/ns/activitystreams');
		expect(rendered).toEqual(featuredSource.cases.find(row => row.id === 'rich')!.expected.json);
	} finally {
		await manager.getRepository(MiNote).update(note.id, { ...note, replyId });
		await manager.getRepository(MiPoll).delete({ noteId: note.id });
		await manager.getRepository(MiEmoji).delete(['featuredemoji0', 'featuredemoji1']);
		await manager.getRepository(MiDriveFile).delete(file.id);
		await manager.getRepository(MiUser).delete('remote');
	}
});
