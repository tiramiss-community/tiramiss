/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MiAccessToken, MiNote, MiPromoRead, MiUser } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test } from 'vitest';
import corpus from '../../../../docs/superpowers/compatibility/promo-read/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/promo-read/observations.json' with { type: 'json' };
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { AuthenticationFailed } from '../../src/modules/access/public.js';
import { createPromoReadStore } from '../../src/platform/database/promo.js';
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
	resources = await connectResources(database.config, createLogger('promo-read-test', () => { }));
	seed = await seedRoleHttp(resources.dataSource);
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: 'author', username: 'author', usernameLower: 'author' },
		{ id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test' },
		{ id: 'reader', username: 'reader', usernameLower: 'reader', token: 'native0000000009' },
		{ id: 'other', username: 'other', usernameLower: 'other', token: 'native0000000008' },
	]);
	await resources.dataSource.getRepository(MiNote).insert(corpus.notes.map(note => ({ ...note, visibility: note.visibility as 'public' | 'specified' | 'followers' })));
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: 'readwrite', userId: 'reader', token: 'readwriteaccesstoken', hash: 'readwriteaccesstoken', permission: ['write:account'] },
		{ id: 'readdenied', userId: 'reader', token: 'readscopeaccesstoken', hash: 'readscopeaccesstoken', permission: ['read:account'] },
	]);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	url = `http://127.0.0.1:${(server.address() as {
		port: number;
	}).port}`;
});
afterAll(async () => {
	const errors: unknown[] = [];
	for (const release of [async () => {
			if (server) {
				await closeHttp(server);
			}
		}, async () => resources?.close(), async () => database?.close()]) {
		try {
			await release();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) {
		throw new AggregateError(errors, 'Promo read cleanup failed');
	}
});

async function call(input: unknown, token: string | null = 'native0000000009') {
	return fetch(`${url}/api/promo/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input as object }) });
}

async function readRows() {
	return (await resources.dataSource.getRepository(MiPromoRead).find()).map(row => ({ id: row.id === 'existing' ? row.id : 'generated', noteId: row.noteId, userId: row.userId })).sort((a, b) => a.noteId.localeCompare(b.noteId) || a.userId.localeCompare(b.userId));
}

function sourcePg(cases: unknown[], preserve = false) {
	return JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/promo-read/source-probe.mjs', import.meta.url)), '--pg'], {
		input: JSON.stringify({ database: database.config.database, cases, preserve }), encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
	}));
}

for (const observation of observations.cases) {
	const item = corpus.cases.find(item => item.id === observation.id)!;
	if (item.fail) {
		continue;
	}
	test(`normal HTTP/PG matches fixed source: ${item.id}`, async () => {
		const reads = resources.dataSource.getRepository(MiPromoRead);
		await reads.clear();
		if (item.rows.length) {
			await reads.insert(item.rows);
		}
		const response = await call(item.input, item.userId === 'other' ? 'native0000000008' : undefined);
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
test('literal pinned callback and Getter with real PostgreSQL reproduce recorded state/errors', () => {
	const cases = corpus.cases.filter(item => !item.fail);
	expect(sourcePg(cases)).toEqual(observations.cases.filter(item => cases.some(c => c.id === item.id)));
});
test('credential/suspension/scope gates precede input; ordinary users may mark reads', async () => {
	await resources.dataSource.getRepository(MiPromoRead).clear();
	for (const [token, status, code] of [[null, 401, 'CREDENTIAL_REQUIRED'], [seed.actors.invalid.token, 401, 'AUTHENTICATION_FAILED'], [seed.actors.suspended.token, 403, 'YOUR_ACCOUNT_SUSPENDED'], ['readscopeaccesstoken', 403, 'PERMISSION_DENIED']] as const) {
		const response = await call({}, token);
		expect(response.status).toBe(status);
		expect((await response.json()).error.code).toBe(code);
	}
	expect(await readRows()).toEqual([]);
	for (const token of [seed.actors.ordinary.token, 'readwriteaccesstoken']) {
		expect((await call({ noteId: 'privatenote' }, token)).status).toBe(204);
	}
	expect(await resources.dataSource.getRepository(MiPromoRead).count()).toBe(2);
});
test('database lookup/existence/insert failures match pinned callback and preserve stored reads', async () => {
	const reads = resources.dataSource.getRepository(MiPromoRead);
	await reads.clear();
	await reads.insert({ id: 'existing', noteId: 'privatenote', userId: 'reader' });
	const previous = await readRows();
	for (const table of ['note', 'promo_read']) {
		await resources.dataSource.query(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
		try {
			const input = { noteId: 'publicnote' };
			const response = await call(input);
			expect(response.status).toBe(500);
			expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
			expect(sourcePg([{ id: table, input, rows: [] }], true)).toEqual([{ id: table, error: { code: 'INTERNAL_ERROR' }, databaseFailure: { operation: table === 'note' ? 'findOneBy' : 'exists', sqlstate: '42P01' } }]);
		} finally {
			await resources.dataSource.query(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`);
		}
		expect(await readRows()).toEqual(previous);
	}
	await resources.dataSource.query('ALTER TABLE promo_read ADD CONSTRAINT promo_read_test_reject CHECK ("noteId" <> \'publicnote\')');
	try {
		const input = { noteId: 'publicnote' };
		expect((await call(input)).status).toBe(500);
		expect(sourcePg([{ id: 'insert', input, rows: [] }], true)).toEqual([{ id: 'insert', error: { code: 'INTERNAL_ERROR' }, databaseFailure: { operation: 'insert', sqlstate: '23514', constraint: 'promo_read_test_reject' } }]);
	} finally {
		await resources.dataSource.query('ALTER TABLE promo_read DROP CONSTRAINT promo_read_test_reject');
	}
	expect(await readRows()).toEqual(previous);
});
test('promo/read uses current suspension without loading Role or Meta authorization data', async () => {
	await resources.dataSource.query('ALTER TABLE role RENAME TO role_unavailable');
	try {
		expect((await call({ noteId: 'privatenote' }, seed.actors.ordinary.token)).status).toBe(204);
	} finally {
		await resources.dataSource.query('ALTER TABLE role_unavailable RENAME TO role');
	}
	await expect(createPromoReadStore(resources.dataSource.manager).readActor('unknown')).rejects.toBeInstanceOf(AuthenticationFailed);
});
test('unique viewer/note key rejects races; deleting Note or viewer cascades read rows', async () => {
	const reads = resources.dataSource.getRepository(MiPromoRead);
	await reads.clear();
	await reads.insert({ id: 'read1', userId: 'reader', noteId: 'publicnote' });
	await expect(reads.insert({ id: 'read2', userId: 'reader', noteId: 'publicnote' })).rejects.toThrow();
	await reads.insert({ id: 'read3', userId: 'other', noteId: 'publicnote' });
	await resources.dataSource.getRepository(MiUser).delete('other');
	expect(await reads.count()).toBe(1);
	await resources.dataSource.getRepository(MiNote).delete('publicnote');
	expect(await reads.count()).toBe(0);
});
