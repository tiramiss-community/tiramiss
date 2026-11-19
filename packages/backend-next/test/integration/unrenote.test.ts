/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { serve } from '@hono/node-server';
import { Redis } from 'ioredis';
import { Meilisearch } from 'meilisearch';
import { MiAccessToken, MiFollowing, MiMeta, MiModerationLog, MiNote, MiUser, MiUserKeypair } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createPostingSearch } from '../../src/composition/posting-search.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createNoteDeleteRateLimiter } from '../../src/platform/note-delete-rate-limit.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let server: ReturnType<typeof serve>;
let origin: string;
const actors = new Map<string, { id: string; token: string }>();
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const logs: string[] = [];
const client = new Meilisearch({ host: `http://127.0.0.1:${process.env.BACKEND_NEXT_TEST_MEILI_PORT ?? 57779}` });
const indexName = `unrenote488-${randomUUID()}`;
const index = client.index(`${indexName}---notes`);

async function tasksApplied() {
	const tasks = await client.tasks.getTasks({ indexUids: [index.uid], limit: 1000 });
	for (const task of tasks.results) {
		expect((await client.tasks.waitForTask(task.uid, { timeout: 10000, interval: 20 })).status).toBe('succeeded');
	}
}

async function note(owner: string, fields: Partial<MiNote> = {}) {
	const noteId = id();
	await resources.dataSource.getRepository(MiNote).insert({ id: noteId, userId: actors.get(owner)!.id, text: null, visibility: 'public', localOnly: true, ...fields });
	return noteId;
}

function call(noteId: unknown, actor = 'alice', extra: object = {}, endpoint = 'unrenote') {
	return fetch(`${origin}/api/notes/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: actors.get(actor)?.token, noteId, ...extra }) });
}

function source(inputs: { noteId: string; userId: string }[]) {
	return JSON.parse(execFileSync(process.execPath, [new URL('../../../../docs/superpowers/compatibility/unrenote/source-probe.mjs', import.meta.url).pathname, '--pg'], {
		input: JSON.stringify({ database: database.config.database, inputs }), encoding: 'utf8', timeout: 20000,
	}));
}

async function responseValue(response: Response) {
	return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.fulltextSearch = { provider: 'meilisearch' };
	database.config.meilisearch = { host: '127.0.0.1', port: process.env.BACKEND_NEXT_TEST_MEILI_PORT ?? '57779', apiKey: '', index: indexName };
	resources = await connectResources(database.config, createLogger('unrenote-test', line => logs.push(line)));
	for (const [i, name] of ['alice', 'bob', 'moved', 'suspended'].entries()) {
		const user = { id: id(), token: `unrenote${String(i).padStart(8, '0')}` };
		actors.set(name, user);
		await resources.dataSource.getRepository(MiUser).insert({ ...user, username: name, usernameLower: name, isSuspended: name === 'suspended', movedToUri: name === 'moved' ? 'https://remote.test/moved' : null });
	}
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: id(), userId: actors.get('alice')!.id, token: 'unrenote-no-scope', hash: 'unrenote-no-scope', permission: [] });
	const keys = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/ap-request/test-only-keypair.json', import.meta.url), 'utf8'));
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: actors.get('alice')!.id, publicKey: keys.publicKeyPem, privateKey: keys.privateKeyPem });
	const remote = id();
	await resources.dataSource.getRepository(MiUser).insert({ id: remote, host: 'unrenote.test', username: 'remote', usernameLower: 'remote', inbox: 'https://unrenote.test/inbox', sharedInbox: 'https://unrenote.test/inbox' });
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: remote, followeeId: actors.get('alice')!.id, followerHost: 'unrenote.test', followerInbox: 'https://unrenote.test/inbox', followerSharedInbox: 'https://unrenote.test/inbox' });
	app = createBackendHttpApp(resources, database.config);
	await new Promise<void>(resolve => {
		server = serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 }, address => {
			origin = `http://127.0.0.1:${address.port}`;
			resolve();
		});
	});
	await vi.waitFor(async () => expect((await client.tasks.getTasks({ indexUids: [index.uid] })).results.length).toBeGreaterThan(0), { timeout: 10000 });
	await tasksApplied();
});
afterAll(async () => {
	if (server) {
 await new Promise<void>(resolve => server.close(() => resolve())); 
}
	await resources?.close(); await database?.close();
	try {
 await client.tasks.waitForTask(await index.delete()); 
} catch { /* Setup may not have created the index. */ }
});

test('real HTTP/PG selection, deletion, counters and existing side effects match pinned callback/delete method', async () => {
	const target = await note('bob', { text: 'original', repliesCount: 3, renoteCount: 7, visibility: 'specified', visibleUserIds: [] });
	const pure = await note('alice', { renoteId: target, renoteUserId: actors.get('bob')!.id, localOnly: false });
	const quote = await note('alice', { renoteId: target, renoteUserId: actors.get('bob')!.id, text: 'quote', replyId: target, localOnly: false });
	const other = await note('bob', { renoteId: target });
	const unrelated = await note('alice', { text: 'unrelated' });
	const inputs = [
		{ noteId: 'missing', userId: actors.get('alice')!.id },
		{ noteId: target, userId: actors.get('moved')!.id },
		{ noteId: target, userId: actors.get('alice')!.id },
		{ noteId: target, userId: actors.get('alice')!.id },
	];
	const upstream = source(inputs);
	const fixture = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/unrenote/source-observations.json', import.meta.url), 'utf8'));
	expect(upstream.identity).toEqual(fixture.identity);
	expect(upstream.observations.every((observation: { nonWaiting: boolean }) => observation.nonWaiting)).toBe(true);
	const search = createPostingSearch(resources.dataSource.manager, database.config, createLogger('unrenote-index', () => {}));
	try {
 await search.index(quote); await tasksApplied(); 
} finally {
 await search.close(); 
}
	expect((await index.getDocument(quote)).id).toBe(quote);
	const subscriber = new Redis({ ...database.config.redisForPubsub, keyPrefix: undefined });
	const messages: { channel: string; message: { type: string } }[] = [];
	subscriber.on('message', (_channel, value) => messages.push(JSON.parse(value)));
	await subscriber.subscribe(new URL(database.config.url).host);
	const started = vi.spyOn(resources.notePostDelete, 'start');
	const removals = vi.spyOn(resources.notePostDelete, 'trackRemoval');
	app = createBackendHttpApp(resources, database.config);
	try {
		for (const [i, input] of inputs.entries()) {
			const actor = [...actors].find(([, user]) => user.id === input.userId)![0];
			const from = removals.mock.calls.length;
			expect(await responseValue(await call(input.noteId, actor))).toEqual(upstream.observations[i].response);
			expect(removals.mock.calls.slice(from).map(([, noteId]) => noteId).sort()).toEqual(upstream.observations[i].selected);
			await resources.notePostDelete.idle();
		}
		const rows = await resources.dataSource.getRepository(MiNote).find({ order: { id: 'ASC' } });
		expect(rows.map(row => ({ id: row.id, repliesCount: row.repliesCount, renoteCount: row.renoteCount }))).toEqual(upstream.rows);
		expect(rows.map(row => row.id).sort()).toEqual([target, other, unrelated].sort());
		const normalized = started.mock.calls.map(([work]) => ({ id: work.snapshot.id, kind: work.kind === 'delivery' ? work.activity.type : work.kind }));
		expect(normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(upstream.events.sort((a: object, b: object) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
		await vi.waitFor(() => expect(messages.filter(m => [pure, quote].some(n => m.channel === `noteStream:${n}`)).map(m => m.message.type)).toEqual(['deleted', 'deleted']));
		await tasksApplied();
		await expect(index.getDocument(quote)).rejects.toThrow();
		const queue = new Queue('deliver', baseQueueOptions(database.config.redisForJobQueue, 'deliver', 5000));
		try {
			const jobs = (await queue.getJobs(['waiting'])).map(job => JSON.parse(job.data.content));
			expect(jobs.filter(activity => activity.type === 'Undo').map(activity => activity.object.type)).toContain('Announce');
			expect(jobs.filter(activity => activity.type === 'Delete').map(activity => activity.object.id)).toContain(`${database.config.url}/notes/${quote}`);
		} finally {
 await queue.close(); 
}
		expect(await resources.dataSource.getRepository(MiModerationLog).count()).toBe(0);
	} finally {
 started.mockRestore(); removals.mockRestore(); subscriber.disconnect(); 
}
});

test('HTTP 204 arrives while DELETE is blocked and shutdown drain waits for the detached operation', async () => {
	const target = await note('bob');
	const renote = await note('alice', { renoteId: target });
	const runner = resources.dataSource.createQueryRunner();
	await runner.connect(); await runner.startTransaction();
	await runner.query('SELECT id FROM note WHERE id = $1 FOR UPDATE', [renote]);
	try {
		const response = await Promise.race([call(target), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('HTTP waited for DELETE')), 2000))]);
		expect(response.status).toBe(204);
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: renote })).toBe(true);
		let drained = false;
		const closing = resources.notePostDelete.close().then(() => {
 drained = true; 
});
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(drained).toBe(false);
		await runner.rollbackTransaction();
		await closing;
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: renote })).toBe(false);
	} finally {
		if (runner.isTransactionActive) {
 await runner.rollbackTransaction(); 
}
		await runner.release();
	}
});

test('detached DELETE failure retains earlier counter work, logs failure and allows ordinary retry', async () => {
	const target = await note('bob', { repliesCount: 2 });
	const renote = await note('alice', { renoteId: target, replyId: target });
	await resources.dataSource.query(`CREATE FUNCTION unrenote_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${renote}' THEN RAISE EXCEPTION 'injected unrenote failure'; END IF; RETURN OLD; END $$`);
	await resources.dataSource.query('CREATE TRIGGER unrenote_fail_delete BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION unrenote_fail_delete()');
	try {
		expect((await call(target)).status).toBe(204);
		await resources.notePostDelete.idle();
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: renote })).toBe(true);
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: target })).repliesCount).toBe(1);
		expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'note-post-delete.failed', kind: 'unrenote', noteId: renote }));
	} finally {
		await resources.dataSource.query('DROP TRIGGER unrenote_fail_delete ON note');
		await resources.dataSource.query('DROP FUNCTION unrenote_fail_delete()');
	}
	expect((await call(target)).status).toBe(204);
	await resources.notePostDelete.idle();
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: renote })).toBe(false);
	expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: target })).repliesCount).toBe(0);
});

test('moved actor is allowed; authentication, suspension, scope and validation precede target lookup', async () => {
	const target = await note('bob');
	const renote = await note('moved', { renoteId: target });
	expect((await call(target, 'moved')).status).toBe(204);
	await resources.notePostDelete.idle();
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: renote })).toBe(false);
	for (const [extra, actor, expected] of [[{}, 'suspended', 'YOUR_ACCOUNT_SUSPENDED'], [{ i: 'unrenote-no-scope' }, 'alice', 'PERMISSION_DENIED'], [{ i: 'wrong' }, 'alice', 'AUTHENTICATION_FAILED'], [{ i: null }, 'alice', 'CREDENTIAL_REQUIRED'], [{}, 'alice', 'INVALID_PARAM']] as const) {
		expect((await (await call(null, actor, extra)).json()).error.code).toBe(expected);
	}
});

test('production rate limit uses its own hourly/minInterval key before validation', async () => {
	const mode = process.env.NODE_ENV;
	process.env.NODE_ENV = 'production';
	app = createBackendHttpApp(resources, database.config);
	try {
		expect((await (await call(null)).json()).error.code).toBe('INVALID_PARAM');
		expect((await (await call(null)).json()).error.code).toBe('RATE_LIMIT_EXCEEDED');
		expect((await (await call(null, 'alice', {}, 'delete')).json()).error.code).toBe('INVALID_PARAM');
		const userId = id();
		const limit = createNoteDeleteRateLimiter(resources.redis, 'notes/unrenote');
		await limit(userId, 300);
		await resources.redis.del(`limit:${userId}:notes/unrenote:min`);
		await expect(limit(userId, 300)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', info: { total: 1 } });
	} finally {
 process.env.NODE_ENV = mode; 
}
});
