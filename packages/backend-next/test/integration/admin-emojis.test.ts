/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiAccessToken, MiEmoji, MiMeta, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { adminEmojiSourceAccess, createAdminEmojiSource, SourceEmojiInputInvalid } from '../helpers/admin-emoji-source.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('admin-emojis-test', () => {}));
	seed = await seedRoleHttp(resources.dataSource);
	await resources.dataSource.getRepository(MiMeta).createQueryBuilder().update().set({ rootUserId: seed.actors.root.id }).execute();
	await resources.dataSource.getRepository(MiEmoji).insert(rows.map(row => ({ originalUrl: 'https://original.test/image', publicUrl: '', ...row })));
	const roleId = seed.codec.newId();
	await resources.dataSource.getRepository(MiRole).insert({ id: roleId, name: 'emoji-manager', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
	await resources.dataSource.query('UPDATE role SET policies = $1 WHERE id = $2', [JSON.stringify({ canManageCustomEmojis: { priority: 1, useDefault: false, value: true } }), roleId]);
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: seed.codec.newId(), roleId, userId: seed.actors.ordinary.id });
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: seed.codec.newId(), userId: seed.actors.ordinary.id, token: 'emoji-read-scoped-token', hash: 'emoji-read-scoped-token', permission: ['read:admin:emoji'] });
	await resources.dataSource.getRepository(MiEmoji).update('cccccccccc', { roleIdsThatCanBeUsedThisEmojiAsReaction: [seed.roleId, roleId, 'missing', seed.roleId] });
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

async function call(endpoint: string, input: object = {}, token: string | null = seed.actors.root.token) {
	return fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, i: token }) });
}

test('ordinary listening HTTP exposes admin emoji reads', async () => {
	const response = await call('admin/emoji/list');
	expect(response.status).toBe(200);
	expect((await response.json())[0].name).toBe('star');
});

const rows = [
	{ id: 'aaaaaaaaaa', name: 'local', category: null, aliases: ['happy smile'], host: null, updatedAt: new Date('2020-01-01T00:00:00Z') },
	{ id: 'bbbbbbbbbb', name: 'local_two', category: 'cat', aliases: ['happy'], host: null, updatedAt: new Date('2020-01-02T12:00:00Z') },
	{ id: 'cccccccccc', name: 'star', category: 'cat', aliases: ['shine'], host: null, isSensitive: true, localOnly: true, updatedAt: null },
	{ id: 'dddddddddd', name: 'remote', category: 'cat', aliases: ['happy'], host: 'remote.test', publicUrl: 'https://public.test/image', uri: 'https://remote.test/emoji', type: 'image/png', updatedAt: new Date('2020-01-03T00:00:00Z') },
	{ id: 'eeeeeeeeee', name: 'literal%_\\mark', category: '', aliases: ['alias%_\\'], host: 'xn--r8jz45g.test', license: 'CC-BY', updatedAt: new Date('2020-01-04T00:00:00Z') },
	{ id: 'ffffffffff', name: 'Case', category: null, aliases: [], host: 'remote.test', updatedAt: null },
];
const endpoints = { list: 'admin/emoji/list', remote: 'admin/emoji/list-remote', v2: 'v2/admin/emoji/list' } as const;
const legacyCases = [{}, { host: 123 }, { host: {} }, { limit: 1 }, { query: '' }, { query: 'local', limit: 1 }, { query: 'happy' }, { query: ':local: :star:', limit: 1 }, { query: ':local: happy' }, { query: '%' }, { query: 'unknown' }, { query: 'case' }, { query: 'Case' }, { sinceId: 'aaaaaaaaaa', limit: 1 }, { untilId: 'ffffffffff', limit: 2 }, { sinceId: 'aaaaaaaaaa', untilId: 'eeeeeeeeee' }, { sinceDate: 0 }, { sinceDate: 1 }, { untilDate: Date.UTC(2020, 0, 1) }, { sinceId: 'aaaaaaaaaa', untilDate: Date.UTC(2020, 0, 1) }];
for (const operation of ['list', 'remote'] as const) {
	for (const [index, params] of [...legacyCases.filter(params => operation === 'list' || !('host' in params)), ...(operation === 'remote' ? [{ host: 'REMOTE.TEST' }, { host: '例え.TEST' }, { host: '' }, { host: 'missing.test' }, { query: '%_\\' }, { host: 'remote.test', sinceId: 'aaaaaaaaaa', limit: 1 }] : [])].entries()) {
		test(`${operation} PostgreSQL/listening HTTP matches literal pinned callback ${index}`, async () => {
			const source = createAdminEmojiSource(resources.dataSource.manager, seed.codec.newId);
			const expected = JSON.parse(JSON.stringify(await source(operation, params)));
			const response = await call(endpoints[operation], params);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(expected);
		});
	}
}
const v2Cases = [
	{}, { query: null }, { limit: 1, page: 2 }, { limit: 1, page: 20 }, { page: 0 }, { sortKeys: [] },
	{ query: { name: 'local remote' } }, { query: { aliases: 'shine happy' } }, { query: { aliases: '%_\\' } },
	{ query: { name: '%_\\' } }, { query: { name: 'LOCAL' } }, { query: { name: 'unknown' } },
	{ query: { hostType: 'local', host: 'remote.test' } }, { query: { hostType: 'remote' } },
	{ query: { hostType: 'remote', host: 'remote xn--r8jz45g' } }, { query: { host: 'remote.test' } },
	{ query: { uri: 'remote absent', publicUrl: 'public' } }, { query: { originalUrl: 'not-found' } },
	{ query: { type: 'png jpeg' } }, { query: { category: 'cat absent' } }, { query: { license: 'CC MIT' } },
	{ query: { isSensitive: false, localOnly: false } }, { query: { isSensitive: true } }, { query: { roleIds: [] } }, { limit: 1, page: 2, query: { name: 'local' } }, { limit: 100, page: 2 },
	{ query: { updatedAtFrom: '2020-01-02', updatedAtTo: '2020-01-03' } },
	{ sinceId: 'bbbbbbbbbb', untilId: 'eeeeeeeeee', sortKeys: ['+name'] },
	{ sinceId: 'aaaaaaaaaa', untilDate: Date.UTC(2020, 0, 1) },
	{ sinceDate: 1, untilId: 'ffffffffff' }, { sinceDate: 0, untilDate: 0 },
	...['id', 'updatedAt', 'name', 'host', 'uri', 'publicUrl', 'type', 'aliases', 'category', 'license', 'isSensitive', 'localOnly', 'roleIdsThatCanBeUsedThisEmojiAsReaction'].flatMap(key => ['+', '-'].map(direction => ({ sortKeys: [`${direction}${key}`, '+id'], limit: 3 }))),
];
for (const [index, params] of v2Cases.entries()) {
	test(`v2 PostgreSQL/listening HTTP matches literal pinned callback and admin packer ${index}`, async () => {
		const source = createAdminEmojiSource(resources.dataSource.manager, seed.codec.newId);
		const expected = JSON.parse(JSON.stringify(await source('v2', params)));
		const response = await call(endpoints.v2, params);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expected);
	});
}
for (const operation of ['list', 'remote', 'v2'] as const) {
	for (const [actor, code, status] of [['moderator', 'ROLE_PERMISSION_DENIED', 403], ['expired', 'ROLE_PERMISSION_DENIED', 403], ['suspended', 'YOUR_ACCOUNT_SUSPENDED', 403], ['readScope', 'PERMISSION_DENIED', 403], ['invalid', 'AUTHENTICATION_FAILED', 401]] as const) {
		test(`${operation} rejects ${actor} before invalid endpoint input`, async () => {
			const response = await call(endpoints[operation], { limit: 0 }, seed.actors[actor].token);
			expect(response.status).toBe(status);
			const actual = (await response.json()).error;
			expect(actual.code).toBe(code);
			if (actor !== 'invalid') {
				const expected = await adminEmojiSourceAccess({ root: actor === 'readScope', administrator: actor === 'suspended', policy: false, suspended: actor === 'suspended', permissions: actor === 'readScope' ? ['read:admin:roles'] : null }, operation);
				expect(actual).toEqual(expected);
			}
		});
	}
	test(`${operation} accepts administrator, native policy and scoped policy users`, async () => {
		for (const token of [seed.actors.administrator.token, seed.actors.ordinary.token, 'emoji-read-scoped-token']) {
			expect((await call(endpoints[operation], {}, token)).status).toBe(200);
		}
	});
	test(`${operation} requires a credential and validates limit and cursors`, async () => {
		expect((await call(endpoints[operation], {}, null)).status).toBe(401);
		for (const input of [{ limit: 0 }, { limit: 101 }, { sinceId: '_' }, { query: 1 }]) {
			expect((await call(endpoints[operation], input)).status).toBe(400);
		}
	});
}
test('v2 role overlap, missing/duplicate role packing and invalid sort/date/search errors match source', async () => {
	const source = createAdminEmojiSource(resources.dataSource.manager, seed.codec.newId);
	const params = { query: { roleIds: [seed.roleId] } };
	expect(await (await call(endpoints.v2, params)).json()).toEqual(JSON.parse(JSON.stringify(await source('v2', params))));
	expect((await call(endpoints.v2, { sortKeys: ['-originalUrl'] })).status).toBe(400);
	await expect(source('v2', { page: -1 })).rejects.toThrow();
	expect((await call(endpoints.v2, { page: -1 })).status).toBe(500);
	for (const query of [{ updatedAtFrom: 'invalid-date' }, { name: '   ' }, { aliases: '   ' }]) {
		await expect(source('v2', { query })).rejects.toThrow();
		const response = await call(endpoints.v2, { query });
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
	}
});
test('DB failures propagate as internal errors without mutation or partial results', async () => {
	const before = await resources.dataSource.getRepository(MiEmoji).count();
	await resources.dataSource.query('ALTER TABLE emoji RENAME TO emoji_unavailable');
	try {
		for (const endpoint of Object.values(endpoints)) {
			const response = await call(endpoint);
			expect(response.status).toBe(500);
			expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
		}
	} finally {
		await resources.dataSource.query('ALTER TABLE emoji_unavailable RENAME TO emoji');
	}
	expect(await resources.dataSource.getRepository(MiEmoji).count()).toBe(before);
});

for (const operation of ['list', 'remote', 'v2'] as const) {
	test(`${operation} validation errors preserve pinned property priority`, async () => {
		const source = createAdminEmojiSource(resources.dataSource.manager, seed.codec.newId);
		for (const params of [{ query: 123, limit: 0, sinceId: '_' }, { sinceId: '_', limit: 0 }, { sinceDate: 'invalid', untilId: '_', limit: 101 }, { query: { name: 2, hostType: 'invalid' }, sortKeys: ['unknown'], limit: 0 }]) {
			let expected: SourceEmojiInputInvalid | undefined;
			try {
				await source(operation, params);
			} catch (error) {
				if (!(error instanceof SourceEmojiInputInvalid)) {
					throw error;
				}
				expected = error;
			}
			expect(expected).toBeDefined();
			const response = await call(endpoints[operation], params);
			expect(response.status).toBe(400);
			expect((await response.json()).error.info).toEqual({ param: expected!.param, reason: expected!.reason });
		}
	});
}
