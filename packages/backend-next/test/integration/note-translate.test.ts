/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiAccessToken, MiFollowing, MiMeta, MiNote, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let fake: Server;
let url: string;
const codec = createIdCodec('aidx');
const viewer = codec.newId(Date.now() - 30000);
const author = codec.newId(Date.now() - 30000);
const token = 'translate0000001';
const secret = 'translation-dummy-secret';
const log: string[] = [];
const requests: { url: string; body: string; headers: Record<string, unknown> }[] = [];
let responseStatus = 200;
let responseBody = JSON.stringify({ translations: [{ detected_source_language: 'EN', text: 'translated' }] });
let noteId: string;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('translate-test', line => log.push(line)));
	await resources.meta.fetch();
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: viewer, username: 'translator', usernameLower: 'translator', token },
		{ id: author, username: 'author', usernameLower: 'author', token: 'translate0000002' },
	]);
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: codec.newId(Date.now()), userId: viewer, token: 'translateScopedToken', hash: 'translateScopedToken', permission: ['read:account'] },
		{ id: codec.newId(Date.now()), userId: viewer, token: 'translateDeniedToken', hash: 'translateDeniedToken', permission: ['write:notes'] },
	]);
	await resources.dataSource.getRepository(MiMeta).createQueryBuilder().update().set({ deeplAuthKey: secret }).execute();
	fake = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) {
			body += chunk;
		}
		requests.push({ url: request.url!, body, headers: request.headers });
		response.writeHead(responseStatus, { 'Content-Type': 'application/json' }).end(responseBody);
	});
	fake.listen(0, '127.0.0.1');
	await once(fake, 'listening');
	const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
	const send = resources.outboundHttp.send;
	resources.outboundHttp.send = (destination, options, extra) => send(`${fakeUrl}/${new URL(destination).host}`, { ...options, allowLocalAddress: true }, extra);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/notes/translate`;
});
beforeEach(async () => {
	requests.length = 0;
	responseStatus = 200;
	responseBody = JSON.stringify({ translations: [{ detected_source_language: 'EN', text: 'translated' }] });
	const manager = resources.dataSource.manager;
	await manager.getRepository(MiMeta).createQueryBuilder().update().set({ deeplAuthKey: secret, deeplIsPro: false, policies: {} }).execute();
	await resources.meta.fetch(true);
	await manager.getRepository(MiUser).update(viewer, { isSuspended: false, movedToUri: null });
	await manager.getRepository(MiUser).update(author, { makeNotesHiddenBefore: null, makeNotesFollowersOnlyBefore: null });
	await manager.getRepository(MiFollowing).createQueryBuilder().delete().execute();
	await manager.getRepository(MiRoleAssignment).createQueryBuilder().delete().execute();
	await manager.getRepository(MiRole).createQueryBuilder().delete().execute();
	noteId = codec.newId(Date.now() - 10000);
	await manager.getRepository(MiNote).insert({ id: noteId, userId: author, text: 'Hello & goodbye', cw: 'CW', visibility: 'public' });
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	if (fake) {
		await new Promise<void>(resolve => fake.close(() => resolve()));
	}
	await resources?.close();
	await database?.close();
});

function call(input: object = {}, credential: string | null = token, method = 'POST') {
	return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ i: credential, noteId, targetLang: 'JA-JP', ...input }) }) });
}

async function expectError(response: Response, code: string, status = 400) {
	expect(response.status).toBe(status);
	expect(await response.json()).toHaveProperty('error.code', code);
	expect(requests).toEqual([]);
}

test('normal listening HTTP uses real token, migrated DB and outbound HTTP form/headers without writes', async () => {
	const before = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: noteId });
	for (const pro of [false, true]) {
		await resources.dataSource.getRepository(MiMeta).createQueryBuilder().update().set({ deeplIsPro: pro }).execute();
		await resources.meta.fetch(true);
		const response = await call({}, 'translateScopedToken');
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toEqual({ sourceLang: 'EN', text: 'translated' });
		const sent = requests.at(-1)!;
		expect(sent.url).toBe(`/${pro ? 'api' : 'api-free'}.deepl.com`);
		expect(sent.body).toBe('text=CW%0A-----%0AHello+%26+goodbye&target_lang=JA');
		expect(sent.headers).toMatchObject({ authorization: `DeepL-Auth-Key ${secret}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json, */*', 'user-agent': database.config.userAgent });
	}
	expect(await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: noteId })).toEqual(before);
});
test('auth, suspension, scope and schema failures happen before translation', async () => {
	await expectError(await call({}, null), 'CREDENTIAL_REQUIRED', 401);
	await expectError(await call({}, 'invalid'), 'AUTHENTICATION_FAILED', 401);
	await expectError(await call({ noteId: null }, 'translateDeniedToken'), 'PERMISSION_DENIED', 403);
	await expectError(await call({ noteId: null }), 'INVALID_PARAM');
	await expectError(await call({ targetLang: null }), 'INVALID_PARAM');
	await resources.dataSource.getRepository(MiUser).update(viewer, { isSuspended: true });
	await expectError(await call(), 'YOUR_ACCOUNT_SUSPENDED', 403);
	expect((await call({}, token, 'GET')).status).toBe(405);
});
test('policy denial precedes note lookup; assigned Role can enable translation', async () => {
	await resources.dataSource.getRepository(MiMeta).createQueryBuilder().update().set({ policies: () => `'{"canUseTranslator":false}'::jsonb` }).execute();
	await expectError(await call({ noteId: codec.newId(Date.now()) }), 'UNAVAILABLE');
	const roleId = codec.newId(Date.now());
	await resources.dataSource.getRepository(MiRole).insert({ id: roleId, name: 'translator', description: '', target: 'manual', updatedAt: new Date(), lastUsedAt: new Date(), policies: () => `'{"canUseTranslator":{"useDefault":false,"priority":1,"value":true}}'::jsonb` });
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), userId: viewer, roleId });
	expect((await call()).status).toBe(200);
	await resources.dataSource.getRepository(MiRoleAssignment).update({ roleId, userId: viewer }, { expiresAt: new Date(0) });
	requests.length = 0;
	await expectError(await call(), 'UNAVAILABLE');
});
test.each(['specified', 'followers', 'hidden', 'time-followers'] as const)('rejects $0 notes and permits the author', async kind => {
	const manager = resources.dataSource.manager;
	if (kind === 'specified' || kind === 'followers') {
		await manager.getRepository(MiNote).update(noteId, { visibility: kind });
	} else {
		await manager.getRepository(MiUser).update(author, kind === 'hidden' ? { makeNotesHiddenBefore: -1 } : { makeNotesFollowersOnlyBefore: -1 });
	}
	await expectError(await call(), 'CANNOT_TRANSLATE_INVISIBLE_NOTE');
	expect((await call({}, 'translate0000002')).status).toBe(200);
});
test.each(['specified', 'follower', 'mention', 'reply-author'] as const)('permits $0 audience', async kind => {
	await resources.dataSource.getRepository(MiNote).update(noteId, {
		visibility: kind === 'specified' ? 'specified' : 'followers',
		visibleUserIds: kind === 'specified' ? [viewer] : [], mentions: kind === 'mention' ? [viewer] : [], replyUserId: kind === 'reply-author' ? viewer : null,
	});
	if (kind === 'follower') {
		await resources.dataSource.getRepository(MiFollowing).insert({ id: codec.newId(Date.now()), followerId: viewer, followeeId: author });
	}
	// The packer checks the actual reply's author, separately from isVisibleForMe's denormalized column.
	if (kind === 'reply-author') {
		const replyId = codec.newId(Date.now() - 20000);
		await resources.dataSource.getRepository(MiNote).insert({ id: replyId, userId: viewer, text: 'parent', visibility: 'public' });
		await resources.dataSource.getRepository(MiNote).update(noteId, { replyId });
	}
	expect((await call()).status).toBe(200);
});
test('missing note, absent key and empty text retain upstream ordering', async () => {
	await expectError(await call({ noteId: codec.newId(Date.now()) }), 'NO_SUCH_NOTE');
	await resources.dataSource.getRepository(MiMeta).createQueryBuilder().update().set({ deeplAuthKey: null }).execute();
	await resources.meta.fetch(true);
	await expectError(await call(), 'UNAVAILABLE');
	await resources.dataSource.getRepository(MiNote).update(noteId, { text: ' \n', cw: null });
	const empty = await call();
	expect(empty.status).toBe(204);
	expect(await empty.text()).toBe('');
	expect(requests).toEqual([]);
});
test.each([400, 500, 'invalid-json', 'invalid-shape'] as const)('outbound $0 fails safely and is not retried', async failure => {
	if (typeof failure === 'number') {
		responseStatus = failure;
	} else {
		responseBody = failure === 'invalid-json' ? `{${secret}` : '{}';
	}
	const response = await call();
	expect(response.status).toBe(500);
	const body = await response.text();
	expect(JSON.parse(body)).toHaveProperty('error.code', 'INTERNAL_ERROR');
	expect(body).not.toContain(secret);
	expect(requests).toHaveLength(1);
	expect(log.join('\n')).not.toContain(secret);
});
