/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { serve } from '@hono/node-server';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiNote, MiUser, MiMeta, MiPoll } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: ReturnType<typeof serve>;
let origin: string;
const codec = createIdCodec('aidx');
const time = Date.now() - 100000;
const author = codec.newId(time - 1000);
const remote = codec.newId(time - 1000);
const token = 'native0000000305';
const ids = Array.from({ length: 110 }, (_, i) => codec.newId(time + i * 100));

async function call(input: object = {}, authenticated = false, headers: Record<string, string> = {}) {
	return fetch(`${origin}/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...input, ...(authenticated ? { i: token } : {}) }) });
}

async function list(input: object = {}, authenticated = false): Promise<string[]> {
	const response = await call(input, authenticated);
	expect(response.status).toBe(200);
	return (await response.json()).map((note: { id: string }) => note.id);
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('notes-list', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', ugcVisibilityForVisitor: 'all' });
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: author, username: 'author', usernameLower: 'author', token },
		{ id: remote, username: 'remote', usernameLower: 'remote', host: 'remote.test' },
	]);
	await resources.dataSource.getRepository(MiNote).insert(ids.map((id, i) => ({ id, userId: author, text: `note ${i}`, visibility: 'public' as const })));
	const app = createBackendHttpApp(resources, database.config);
	server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
	await new Promise<void>(resolve => server.on('listening', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') {
throw new Error('no address');
}
	origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => server ? server.close(error => error ? reject(error) : resolve()) : resolve());
	await resources?.close();
	await database?.close();
});

test('normal HTTP defaults, limit and exclusive ID/date precedence and direction', async () => {
	expect(await list()).toEqual(ids.slice(-10).reverse());
	expect(await list({ limit: 100 })).toEqual(ids.slice(-100).reverse());
	expect(await list({ sinceId: ids[2], limit: 2 })).toEqual([ids[3], ids[4]]);
	expect(await list({ untilId: ids[5], limit: 2 })).toEqual([ids[4], ids[3]]);
	expect(await list({ sinceId: ids[2], untilId: ids[5] })).toEqual([ids[4], ids[3]]);
	expect(await list({ sinceId: ids[5], untilId: ids[2] })).toEqual([]);
	expect(await list({ sinceId: ids[2], untilDate: time })).toEqual(ids.slice(3, 13));
	expect(await list({ untilId: ids[5], sinceDate: time + 100000 })).toEqual(ids.slice(0, 5).reverse());
	expect(await list({ sinceDate: time + 250, untilDate: time + 450 })).toEqual([ids[4], ids[3]]);
	expect(await list({ sinceDate: time + 250, limit: 2 })).toEqual([ids[3], ids[4]]);
	expect(await list({ untilDate: time + 450, limit: 2 })).toEqual([ids[4], ids[3]]);
	expect(await list({ sinceDate: 0, untilDate: 0 })).toEqual(ids.slice(-10).reverse());
	expect(await list({ sinceId: ids.at(-1) })).toEqual([]);
});

test('notes conditions include both boolean values and filter before limit', async () => {
	const db = resources.dataSource;
	const fileNote = ids[109];
	await db.getRepository(MiNote).update(ids[108], { userId: remote, userHost: 'remote.test' });
	await db.getRepository(MiNote).update(ids[107], { visibility: 'home' });
	await db.getRepository(MiNote).update(ids[106], { localOnly: true });
	await db.getRepository(MiNote).update(fileNote, { fileIds: ['missing'], replyId: ids[0], renoteId: ids[1], hasPoll: true });
	await db.getRepository(MiPoll).insert({ noteId: fileNote, userId: author, choices: ['a'], votes: [0], multiple: false, noteVisibility: 'public' });
	for (const filter of ['reply', 'renote', 'withFiles', 'poll']) {
		expect(await list({ [filter]: true })).toEqual([fileNote]);
		expect(await list({ [filter]: false, limit: 1 })).toEqual([ids[108]]);
	}
	expect(await list({ local: true, limit: 2 })).toEqual([fileNote, ids[105]]);
	expect(await list({ local: false, limit: 2 })).toEqual([fileNote, ids[108]]);
	await db.getRepository(MiUser).update(author, { isSuspended: true });
	expect(await list({ reply: true })).toEqual([fileNote]);
	await db.getRepository(MiUser).update(author, { isSuspended: false });
});

test('guest UGC filters before limit; authenticated selection preserves upstream guest packing', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'none' });
	expect(await list()).toEqual([]);
	const signed = await call({ limit: 1 }, true);
	expect(await signed.json()).toMatchObject([{ id: ids[109], isHidden: true, text: null }]);
	await db.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'local' });
	expect(await list({ untilId: ids[109], limit: 1 })).toEqual([ids[105]]);
	expect(await list({ untilId: ids[109], limit: 1 }, true)).toEqual([ids[108]]);
	await db.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'all' });
	await db.getRepository(MiUser).update(author, { requireSigninToViewContents: true });
	for (const authenticated of [true, false]) {
		const response = await call({ limit: 1 }, authenticated);
		expect(await response.json()).toMatchObject([{ id: ids[109], isHidden: true, text: null }]);
	}
	await db.getRepository(MiUser).update(author, { requireSigninToViewContents: false });
});

test.skipIf(!process.env.BACKEND_NEXT_UPSTREAM_PATH)('pinned notes callback and QueryService run directly on the same PostgreSQL rows', async () => {
	const inputs = [
		{}, { limit: 1 }, { limit: 100 }, { sinceId: ids[2] }, { untilId: ids[5] },
		{ sinceId: ids[2], untilId: ids[5] }, { sinceId: ids[5], untilId: ids[2] },
		{ sinceId: ids[2], untilDate: time }, { untilId: ids[5], sinceDate: time + 5000 },
		{ sinceDate: time + 250 }, { untilDate: time + 450 }, { sinceDate: time + 250, untilDate: time + 450 },
		{ sinceDate: 0, untilDate: 0 }, { local: true },
		...['reply', 'renote', 'withFiles', 'poll'].flatMap(key => [true, false].map(value => ({ [key]: value }))),
	];
	const cases = ['all', 'local', 'none'].flatMap(ugc => [true, false].flatMap(authenticated => inputs.map(input => ({
		ugc, authenticated, input, dateIds: { [String(time)]: codec.newId(time), [String(time + 250)]: codec.newId(time + 250), [String(time + 450)]: codec.newId(time + 450), [String(time + 5000)]: codec.newId(time + 5000) },
	}))));
	const expected = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/notes-pagination/source-probe.mjs', import.meta.url)), '--pg'], {
		input: JSON.stringify({ database: database.config.database, cases }), encoding: 'utf8',
	}));
	for (const [index, item] of cases.entries()) {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: item.ugc as 'all' | 'local' | 'none' });
		expect(await list(item.input, item.authenticated), JSON.stringify(item)).toEqual(expected[index]);
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { ugcVisibilityForVisitor: 'all' });
});

test.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { sinceId: 'bad-id' }, { sinceDate: 1.5 }, { poll: null }, { local: 'true' }])('invalid input %j', async input => {
	const response = await call(input);
	expect(response.status).toBe(400);
	expect(await response.json()).toHaveProperty('error.code', 'INVALID_PARAM');
});
test('authentication precedes input validation; default route rejects GET and sends CORS', async () => {
	const response = await call({ limit: 0 }, false, { Authorization: 'Bearer invalid' });
	expect(response.status).toBe(401);
	expect(await response.json()).toHaveProperty('error.code', 'AUTHENTICATION_FAILED');
	expect((await fetch(`${origin}/api/notes`)).status).toBe(405);
	expect((await call()).headers.get('access-control-allow-origin')).toBe('*');
});

test.each(['update', 'delete', 'shared-author'])('joined snapshots and ID-loaded author precedence survive a concurrent %s after selection', async change => {
	const db = resources.dataSource;
	const userId = codec.newId(time - 2000);
	const replyId = codec.newId(time + 20000);
	const renoteId = codec.newId(time + 20100);
	const rootId = codec.newId(time + 20200);
	const referenceAuthor = change === 'shared-author' ? userId : author;
	await db.getRepository(MiUser).insert({ id: userId, username: `race${change}`, usernameLower: `race${change}`, name: 'selected author' });
	await db.getRepository(MiNote).insert([
		{ id: replyId, userId: referenceAuthor, text: 'selected reply', visibility: 'public' },
		{ id: renoteId, userId: referenceAuthor, text: 'selected renote', visibility: 'public' },
		{ id: rootId, userId, text: 'selected root', visibility: 'public', replyId, renoteId, replyUserId: referenceAuthor, renoteUserId: referenceAuthor },
	]);
	let expected: object = [{ id: rootId, text: 'selected root', user: { id: userId, name: 'selected author' },
		reply: { id: replyId, text: 'selected reply' }, renote: { id: renoteId, text: 'selected renote' } }];
	if (process.env.BACKEND_NEXT_UPSTREAM_PATH) {
		const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/notes-pagination/source-probe.mjs', import.meta.url)), '--pg'], {
			input: JSON.stringify({ snapshot: true, database: database.config.database,
				...(change === 'shared-author' ? { changeUserAfterSelection: { id: userId, patch: { name: 'changed author', requireSigninToViewContents: true } } } : {}),
				cases: [{ ugc: 'all', authenticated: false, input: { limit: 1 }, dateIds: {} }] }), encoding: 'utf8',
		}));
		expected = result[0];
	}
	if (change === 'shared-author') {
		expect(expected).toMatchObject([{ user: { name: process.env.BACKEND_NEXT_UPSTREAM_PATH ? 'changed author' : 'selected author' } }]);
		expected = [{ id: rootId, text: null, isHidden: true, user: { id: userId, name: 'changed author' },
			reply: { id: replyId, text: null, isHidden: true }, renote: { id: renoteId, text: null, isHidden: true } }];
		await db.getRepository(MiUser).update(userId, { name: 'selected author', requireSigninToViewContents: false });
	}
	const repository = db.getRepository(MiNote);
	const original = repository.createQueryBuilder.bind(repository);
	let reached!: () => void;
	let release!: () => void;
	const selected = new Promise<void>(resolve => {
 reached = resolve; 
});
	const resume = new Promise<void>(resolve => {
 release = resolve; 
});
	const spy = vi.spyOn(repository, 'createQueryBuilder').mockImplementation((...args) => {
		const query = original(...args);
		if (args[0] === 'note') {
			const getMany = query.getMany.bind(query);
			query.getMany = async () => {
				const rows = await getMany();
				reached();
				await resume;
				return rows;
			};
		}
		return query;
	});
	try {
		const pending = call({ limit: 1 });
		await selected;
		if (change !== 'delete') {
			await db.getRepository(MiUser).update(userId, { name: 'changed author', requireSigninToViewContents: true });
			await repository.update([replyId, renoteId], { text: 'changed reference' });
		} else {
			await repository.delete([replyId, renoteId]);
			await db.getRepository(MiUser).delete(userId);
		}
		release();
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject(expected);
	} finally {
		release();
		spy.mockRestore();
		await repository.delete([rootId, replyId, renoteId]);
		await db.getRepository(MiUser).delete(userId);
	}
});
