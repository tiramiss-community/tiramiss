/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MiAccessToken, MiNote, MiPromoNote, MiUser } from 'backend-upstream/entities';
import corpus from '../../../../docs/superpowers/compatibility/promo/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/promo/observations.json' with { type: 'json' };
import { afterAll, beforeAll, expect, test } from 'vitest';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let url: string;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('promo-test', () => {}));
	seed = await seedRoleHttp(resources.dataSource);
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: 'author', username: 'author', usernameLower: 'author' },
		{ id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test' },
	]);
	await resources.dataSource.getRepository(MiNote).insert(corpus.notes.map(note => ({ ...note, visibility: note.visibility as 'public' | 'specified' | 'followers' })));
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: 'promowrite', userId: seed.actors.moderator.id, token: 'promowriteaccesstoken', hash: 'promowriteaccesstoken', permission: ['write:admin:promo'] },
		{ id: 'promodenied', userId: seed.actors.moderator.id, token: 'promoreadaccesstoken', hash: 'promoreadaccesstoken', permission: ['read:account'] },
	]);
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

async function call(input: unknown, token: string | null = seed.actors.root.token) {
	return fetch(`${url}/api/admin/promo/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input as object }) });
}

test('normal HTTP exposes the moderator promotion operation', async () => {
	const response = await call({}, null);
	expect(response.status).toBe(401);
	expect((await response.json()).error.code).toBe('CREDENTIAL_REQUIRED');
});

async function readRows() {
	return (await resources.dataSource.getRepository(MiPromoNote).find({ order: { noteId: 'ASC' } }))
		.map(row => ({ noteId: row.noteId, userId: row.userId, expiresAt: row.expiresAt.getTime() }));
}

for (const observation of observations.cases) {
	const item = corpus.cases.find(item => item.id === observation.id)!;
	if (item.fail) {
		continue;
	}
	test(`normal HTTP and PG match fixed source: ${item.id}`, async () => {
		const promos = resources.dataSource.getRepository(MiPromoNote);
		await promos.clear();
		if (item.rows.length) {
			await promos.insert(item.rows.map(row => ({ ...row, expiresAt: new Date(row.expiresAt) })));
		}
		const response = await call(item.input);
		if (observation.error) {
			expect(response.status).toBe(400);
			expect((await response.json()).error).toMatchObject(observation.error);
		} else {
			expect(response.status).toBe(204);
			expect(await response.text()).toBe('');
		}
		expect(await readRows()).toEqual(observation.rows);
	});
}

function sourcePg(cases: unknown[], preserve = false) {
	return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/promo/source-probe.mjs', import.meta.url)), '--pg'], {
		input: JSON.stringify({ database: database.config.database, cases, preserve }), encoding: 'utf8',
	}));
}

test('literal pinned callback and Getter run with real PostgreSQL and match normal HTTP storage/errors', async () => {
	const cases = corpus.cases.filter(item => !item.fail);
	expect(sourcePg(cases)).toEqual(observations.cases.filter(item => cases.some(c => c.id === item.id)));
});

test('current moderator/admin/root roles, expiry, scope and suspension gate writes before input validation', async () => {
	await resources.dataSource.getRepository(MiPromoNote).clear();
	for (const [actor, code] of [['ordinary', 'ROLE_PERMISSION_DENIED'], ['expired', 'ROLE_PERMISSION_DENIED'], ['invalid', 'AUTHENTICATION_FAILED'], ['suspended', 'YOUR_ACCOUNT_SUSPENDED']] as const) {
		const response = await call({}, seed.actors[actor].token);
		expect((await response.json()).error.code).toBe(code);
	}
	expect((await (await call({}, 'promoreadaccesstoken')).json()).error.code).toBe('PERMISSION_DENIED');
	expect(await readRows()).toEqual([]);
	for (const actor of ['root', 'moderator', 'administrator']) {
		expect((await call({ noteId: 'publicnote', expiresAt: 0 }, seed.actors[actor].token)).status).toBe(204);
		await resources.dataSource.getRepository(MiPromoNote).clear();
	}
	expect((await call({ noteId: 'privatenote', expiresAt: -1 }, 'promowriteaccesstoken')).status).toBe(204);
	expect(await readRows()).toEqual([{ noteId: 'privatenote', userId: 'author', expiresAt: -1 }]);
	await resources.dataSource.getRepository(MiUser).update(seed.actors.moderator.id, { isSuspended: true });
	try {
		expect((await (await call({}, 'promoreadaccesstoken')).json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update(seed.actors.moderator.id, { isSuspended: false });
	}
});

test('database note/exists/insert failures preserve state and match real pinned callback failures', async () => {
	const promos = resources.dataSource.getRepository(MiPromoNote);
	await promos.clear();
	await promos.insert({ noteId: 'privatenote', userId: 'author', expiresAt: new Date(0) });
	const previous = await readRows();
	for (const table of ['note', 'promo_note']) {
		await resources.dataSource.query(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
		try {
			const input = { noteId: 'publicnote', expiresAt: 0 };
			const response = await call(input);
			expect(response.status).toBe(500);
			expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
			expect(sourcePg([{ id: table, input, rows: [] }], true)).toEqual([{ id: table, error: { code: 'INTERNAL_ERROR' } }]);
		} finally {
			await resources.dataSource.query(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`);
		}
		expect(await readRows()).toEqual(previous);
	}
	const item = { id: 'invalid-date-insert', input: { noteId: 'publicnote', expiresAt: 8640000000000001 }, rows: previous };
	const source = sourcePg([item]);
	expect(source).toEqual([{ id: item.id, error: { code: 'INTERNAL_ERROR' }, rows: previous }]);
	const response = await call(item.input);
	expect(response.status).toBe(500);
	expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
	expect(await readRows()).toEqual(previous);
});

test('upstream primary key and note CASCADE preserve existing promotions and remove deleted notes', async () => {
	const promos = resources.dataSource.getRepository(MiPromoNote);
	await promos.clear();
	await promos.insert({ noteId: 'publicnote', userId: 'author', expiresAt: new Date(0) });
	await expect(promos.insert({ noteId: 'publicnote', userId: 'author', expiresAt: new Date(1000) })).rejects.toThrow();
	await expect(promos.insert({ noteId: 'unknown', userId: 'author', expiresAt: new Date(0) })).rejects.toThrow();
	expect(await readRows()).toEqual([{ noteId: 'publicnote', userId: 'author', expiresAt: 0 }]);
	await resources.dataSource.getRepository(MiNote).delete('publicnote');
	expect(await readRows()).toEqual([]);
});
