/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiHashtag, MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { createNoteHashtagWriter } from '../../src/platform/database/note-hashtags.js';
import { createUserHashtagWriter } from '../../src/platform/database/user-hashtags.js';
import { createHashtagCatalogReader } from '../../src/platform/database/hashtag-catalog.js';
import { canonicalizeHashtagResult } from '../../../../docs/superpowers/compatibility/hashtag-catalog/comparison.mjs';
import corpus from '../../../../docs/superpowers/compatibility/hashtag-catalog/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/hashtag-catalog/observations.json' with { type: 'json' };
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('hashtag-catalog-test', () => {}));
	await resources.dataSource.getRepository(MiHashtag).insert(corpus.rows);
	await resources.dataSource.getRepository(MiUser).insert({ id: 'reader', username: 'reader', usernameLower: 'reader', token: 'reader0123456789', isSuspended: true });
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: 'scoped', userId: 'reader', token: 'hashtagscopedaccesstoken', hash: 'hashtagscopedaccesstoken', permission: [] });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

async function request(endpoint: string, input: unknown, token?: string) {
	return fetch(`${url}/api/hashtags/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input as object, ...(token ? { i: token } : {}) }) });
}

for (const observation of observations.cases) {
	test(`listening HTTP / PG match fixed-source PG: ${observation.id}`, async () => {
		const item = corpus.cases.find(item => item.id === observation.id)!;
		const before = await resources.dataSource.getRepository(MiHashtag).find({ order: { id: 'ASC' } });
		const response = await request(item.endpoint, item.input);
		const body = await response.json();
		if ('error' in observation) {
			const code = observation.error!.code;
			expect(response.status).toBe(code === '2201X' ? 500 : 400);
			expect(body.error).toMatchObject(code === '2201X' ? { code: 'INTERNAL_ERROR' } : observation.error!);
		} else {
			expect(response.status).toBe(200);
			expect(canonicalizeHashtagResult(item, body, corpus.rows)).toEqual(canonicalizeHashtagResult(item, observation.result, corpus.rows));
		}
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
		expect(await resources.dataSource.getRepository(MiHashtag).find({ order: { id: 'ASC' } })).toEqual(before);
	});
}

test('public routes accept native suspended and unscoped OAuth readers; invalid token fails authentication', async () => {
	for (const endpoint of ['list', 'search', 'show']) {
		const input = endpoint === 'list' ? { sort: '+mentionedUsers' } : endpoint === 'search' ? { query: 'AL' } : { tag: 'alpha' };
		const anonymous = await (await request(endpoint, input)).json();
		for (const token of ['reader0123456789', 'hashtagscopedaccesstoken']) {
			const response = await request(endpoint, input, token);
			expect(response.status).toBe(200);
			expect(canonicalizeHashtagResult({ id: 'credential', endpoint, input }, await response.json(), corpus.rows)).toEqual(canonicalizeHashtagResult({ id: 'credential', endpoint, input }, anonymous, corpus.rows));
		}
		const invalid = await request(endpoint, input, 'invalidtoken');
		expect(invalid.status).toBe(401);
		expect((await invalid.json()).error.code).toBe('AUTHENTICATION_FAILED');
	}
});

test('GET is rejected, OPTIONS supplies CORS, malformed JSON is rejected', async () => {
	for (const endpoint of ['list', 'search', 'show']) {
		expect((await fetch(`${url}/api/hashtags/${endpoint}`)).status).toBe(405);
		const options = await fetch(`${url}/api/hashtags/${endpoint}`, { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST' } });
		expect(options.status).toBe(204);
		expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect((await fetch(`${url}/api/hashtags/${endpoint}`, { method: 'POST', body: '{' })).status).toBe(400);
	}
});

test('existing Note and user producers publish all six stored counts without exposing membership or rewriting rows', async () => {
	const ids = () => 'producer';
	await createNoteHashtagWriter(resources.dataSource.manager, ids).mention({ tag: 'producer', userId: 'local', userHost: null });
	await createNoteHashtagWriter(resources.dataSource.manager, ids).mention({ tag: 'producer', userId: 'remote', userHost: 'remote.test' });
	await createUserHashtagWriter(resources.dataSource.manager, ids).change({ tag: 'producer', userId: 'remote', userHost: 'remote.test', attached: true });
	const repository = resources.dataSource.getRepository(MiHashtag);
	const before = await repository.findOneByOrFail({ name: 'producer' });
	const response = await request('show', { tag: 'ＰＲＯＤＵＣＥＲ' });
	expect(await response.json()).toEqual({ tag: 'producer', mentionedUsersCount: 2, mentionedLocalUsersCount: 1, mentionedRemoteUsersCount: 1, attachedUsersCount: 1, attachedLocalUsersCount: 0, attachedRemoteUsersCount: 1 });
	expect(await (await request('search', { query: 'PROD' })).json()).toEqual(['producer']);
	const list = await (await request('list', { sort: '+mentionedUsers', attachedToRemoteUserOnly: true, limit: 100 })).json();
	expect(list.some((row: { tag: string }) => row.tag === 'producer')).toBe(true);
	expect(await repository.findOneByOrFail({ name: 'producer' })).toEqual(before);
});

test('unavailable Hashtag storage remains a server error for every route', async () => {
	await resources.dataSource.query('ALTER TABLE hashtag RENAME TO hashtag_unavailable');
	try {
		for (const [endpoint, input] of [['list', { sort: '+mentionedUsers' }], ['search', { query: '' }], ['show', { tag: 'alpha' }]] as const) {
			const response = await request(endpoint, input);
			expect(response.status).toBe(500);
			expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
		}
	} finally {
		await resources.dataSource.query('ALTER TABLE hashtag_unavailable RENAME TO hashtag');
	}
});

test('search projects only names and show projects only the seven public fields on real PG', async () => {
	const reader = createHashtagCatalogReader(resources.dataSource.manager);
	const queries = vi.spyOn(resources.dataSource.logger, 'logQuery');
	try {
		expect((await reader.search({ query: 'al', limit: 2, offset: 1 })).sort()).toEqual(['alphabet', 'alpine']);
		expect(queries).toHaveBeenCalledTimes(1);
		const searchSql = queries.mock.calls.at(-1)![0];
		expect(searchSql.slice(0, searchSql.indexOf(' FROM '))).toBe('SELECT "tag"."name" AS "name"');
		expect(searchSql).toContain('ORDER BY "tag"."mentionedLocalUsersCount" DESC');
		expect(searchSql).toContain('LIMIT 2 OFFSET 1');
		const row = await reader.find('alpha');
		expect(Object.keys(row!).sort()).toEqual(['name', 'mentionedUsersCount', 'mentionedLocalUsersCount', 'mentionedRemoteUsersCount', 'attachedUsersCount', 'attachedLocalUsersCount', 'attachedRemoteUsersCount'].sort());
		expect(queries).toHaveBeenCalledTimes(2);
		const showSql = queries.mock.calls.at(-1)![0];
		for (const field of ['id', 'mentionedUserIds', 'mentionedLocalUserIds', 'mentionedRemoteUserIds', 'attachedUserIds', 'attachedLocalUserIds', 'attachedRemoteUserIds']) {
			expect(searchSql.slice(0, searchSql.indexOf(' FROM '))).not.toContain(`"${field}"`);
			expect(showSql.slice(0, showSql.indexOf(' FROM '))).not.toContain(`"${field}"`);
		}
	} finally {
		queries.mockRestore();
	}
});
