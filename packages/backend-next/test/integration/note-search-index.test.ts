/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Meilisearch } from 'meilisearch';
import { MiNote, MiUser } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createPostingSearch } from '../../src/composition/posting-search.js';
import { createLogger } from '../../src/platform/logger.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { gate, searchGateway } from '../helpers/search-gateway.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
const logs: string[] = [];
const logger = createLogger('search-integration', line => logs.push(line));
const client = new Meilisearch({ host: `http://127.0.0.1:${process.env.BACKEND_NEXT_TEST_MEILI_PORT ?? 57779}` });
const indexName = `search233-${randomUUID()}`;
const index = client.index(`${indexName}---notes`);

async function tasksApplied() {
	const tasks = await client.tasks.getTasks({ indexUids: [index.uid], limit: 1000 });
	for (const task of tasks.results) {
		expect((await client.tasks.waitForTask(task.uid, { timeout: 10000, interval: 20 })).status).toBe('succeeded');
	}
}

async function create(input: object = {}, application = app) {
	const response = await application.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'uniqueindexneedle', localOnly: true, ...input }) });
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()).createdNote as { id: string };
}

async function remove(id: string, application = app) {
	return application.request('/api/notes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.ordinary.token, noteId: id }) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.fulltextSearch = { provider: 'meilisearch' };
	database.config.meilisearch = { host: '127.0.0.1', port: process.env.BACKEND_NEXT_TEST_MEILI_PORT ?? '57779', apiKey: '', index: indexName };
	resources = await connectResources(database.config, logger);
	seeded = await seedRoleHttp(resources.dataSource);
	app = createBackendHttpApp(resources, database.config);
	// Startup only submits settings; the test waits for engine application.
	await vi.waitFor(async () => expect((await client.tasks.getTasks({ indexUids: [index.uid] })).results.length).toBeGreaterThan(0), { timeout: 10000, interval: 20 });
	await tasksApplied();
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
	try {
		await client.tasks.waitForTask(await index.delete());
	} catch { /* Setup may have failed before index creation. */ }
});

test('real HTTP create/delete materializes exact ID-derived document, CW search and settings with SDK 0.62.0', async () => {
	const publicNote = await create({ text: 'uniqueindexneedle #SearchTag' });
	const home = await create({ visibility: 'home', text: null, cw: 'cwonlyneedle', poll: { choices: ['one', 'two'] } });
	const hidden = await create({ visibility: 'followers' });
	await resources.notePostSave.idle(); await tasksApplied();
	const row = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: publicNote.id });
	expect(await index.getDocument(publicNote.id)).toEqual({ id: publicNote.id, createdAt: seeded.codec.createdAtFromId(publicNote.id), userId: seeded.actors.ordinary.id, userHost: null, channelId: null, text: row.text, cw: null, tags: ['searchtag'] });
	expect((await index.search('cwonlyneedle')).hits.map(n => n.id)).toEqual([home.id]);
	await expect(index.getDocument(hidden.id)).rejects.toThrow();
	const settings = await index.getSettings();
	expect(settings).toMatchObject({ searchableAttributes: ['text', 'cw'], sortableAttributes: ['createdAt'], filterableAttributes: ['channelId', 'createdAt', 'tags', 'userHost', 'userId'], typoTolerance: { enabled: false }, pagination: { maxTotalHits: 10000 } });
	expect((await index.getRawInfo()).primaryKey).toBe('id');
	expect((await remove(publicNote.id)).status).toBe(204);
	await resources.notePostDelete.idle(); await tasksApplied();
	expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: publicNote.id })).toBeNull();
	await expect(index.getDocument(publicNote.id)).rejects.toThrow();
});

test('scope lists use exact hosts and local authors; delete removes documents despite current scope and null content', async () => {
	const remote = seeded.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiUser).insert({ id: remote, host: 'allowed.test', username: 'searchremote', usernameLower: 'searchremote' });
	const id = seeded.codec.newId(Date.now());
	await resources.dataSource.getRepository(MiNote).insert({ id, userId: remote, userHost: 'allowed.test', text: 'remoteneedle', visibility: 'home' });
	const search = createPostingSearch(resources.dataSource.manager, { ...database.config, meilisearch: { ...database.config.meilisearch!, scope: ['allowed.test'] } }, logger);
	try {
		await search.index(id); await tasksApplied(); expect((await index.getDocument(id)).userHost).toBe('allowed.test');
	} finally {
		await search.close();
	}
	// The normal local scope still unindexes this remote author, even after content becomes null.
	await resources.dataSource.getRepository(MiNote).update(id, { text: null, cw: null });
	const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: seeded.actors.root.token, noteId: id }) });
	expect(response.status, await response.clone().text()).toBe(204);
	await resources.notePostDelete.idle(); await tasksApplied();
	await expect(index.getDocument(id)).rejects.toThrow();
});

test('failed database DELETE still starts and applies unindex', async () => {
	const note = await create(); await resources.notePostSave.idle(); await tasksApplied();
	await resources.dataSource.query(`CREATE FUNCTION search_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${note.id}' THEN RAISE EXCEPTION 'injected'; END IF; RETURN OLD; END $$`);
	await resources.dataSource.query('CREATE TRIGGER search_fail_delete BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION search_fail_delete()');
	try {
		expect((await remove(note.id)).status).toBe(500);
		await resources.notePostDelete.idle(); await tasksApplied();
		expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: note.id })).not.toBeNull();
		await expect(index.getDocument(note.id)).rejects.toThrow();
	} finally {
		await resources.dataSource.query('DROP TRIGGER search_fail_delete ON note');
		await resources.dataSource.query('DROP FUNCTION search_fail_delete()');
	}
});

test('blocked SDK HTTP submission leaves saved HTTP success and drain pending; failed submissions log without rollback', async () => {
	const held = gate(); const entered = gate();
	const gateway = await searchGateway(async request => {
		if (request.method === 'POST') {
			entered.release(); await held.promise; return { status: 503, body: { message: 'injected', code: 'injected', type: 'internal', link: '' } };
		}
	});
	const config = { ...database.config, meilisearch: gateway.config };
	const other = await connectResources(config, logger);
	try {
		const otherApp = createBackendHttpApp(other, config);
		const note = await create({}, otherApp); await entered.promise;
		expect(await other.dataSource.getRepository(MiNote).findOneBy({ id: note.id })).not.toBeNull();
		let drained = false;
		const draining = other.notePostSave.idle().then(() => {
			drained = true;
		});
		await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
		held.release(); await draining;
		expect(logs.join('')).toContain('note-post-save.failed');
		expect((await other.dataSource.getRepository(MiUser).findOneByOrFail({ id: seeded.actors.ordinary.id })).notesCount).toBeGreaterThan(0);
		expect((await remove(note.id, otherApp)).status).toBe(204);
		await other.notePostDelete.idle();
	} finally {
		held.release(); await other.close(); await gateway.close();
	}
});

test.each([undefined, 'sqlLike', 'sqlPgroonga'] as const)('HTTP with provider %s and a Meili block performs no engine requests', async provider => {
	const gateway = await searchGateway();
	const config = { ...database.config, fulltextSearch: provider ? { provider } : undefined, meilisearch: gateway.config };
	const other = await connectResources(config, logger);
	try {
		const otherApp = createBackendHttpApp(other, config); const note = await create({}, otherApp);
		await other.notePostSave.idle(); expect((await remove(note.id, otherApp)).status).toBe(204);
		await other.notePostDelete.idle(); expect(gateway.requests).toEqual([]);
	} finally {
		await other.close(); await gateway.close();
	}
});

test('saved creation snapshot remains sufficient after immediate physical deletion without imposing create/delete ordering', async () => {
	let accepted: import('../../src/modules/note/public.js').NotePostSaveInput | undefined;
	const snapshotApp = createBackendHttpApp({ ...resources, notePostSave: { ...resources.notePostSave, start: input => {
		accepted = input;
	} } }, database.config);
	const note = await create({ text: 'snapshotneedle' }, snapshotApp);
	expect(accepted?.createdSnapshot?.note.id).toBe(note.id);
	await resources.dataSource.getRepository(MiNote).delete(note.id);
	const search = createPostingSearch(resources.dataSource.manager, database.config, logger);
	try {
		await search.index(note.id, accepted?.createdSnapshot); await tasksApplied();
		expect((await index.getDocument(note.id)).text).toBe('snapshotneedle');
		expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: note.id })).toBeNull();
	} finally {
		await search.close();
	}
});
