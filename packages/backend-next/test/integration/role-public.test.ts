/*
	* SPDX-FileCopyrightText: syuilo and misskey-project
	* SPDX-License-Identifier: AGPL-3.0-only
	*/
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createRoleHttpApp } from '../../src/composition/role-http.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createRoleShowReader } from '../../src/platform/database/role-show.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { user } from '../unit/role/fixtures.js';
import type { Server } from 'node:http';

const corpus = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/role-public/corpus.json', import.meta.url), 'utf8'));
const observations = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/role-public/observations.json', import.meta.url), 'utf8'));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: Server;
let origin: string;
let app: ReturnType<typeof createBackendHttpApp>;
let userId: string;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('role-public-test', () => {}));
	seed = await seedRoleHttp(resources.dataSource);
	const db = resources.dataSource;
	await db.getRepository(MiRoleAssignment).clear();
	await db.getRepository(MiRole).createQueryBuilder().delete().execute();
	const ids: string[] = [...new Set<string>(corpus.assignments.map((row: { userId: string }) => row.userId))];
	userId = ids[0];
	await db.getRepository(MiUser).insert(ids.map((id, n) => ({ id, username: `role-public-${n}`, usernameLower: `role-public-${n}` })));
	await db.getRepository(MiRole).insert(corpus.roles.map((row: object & { updatedAt: string; lastUsedAt: string }) => ({ ...row, updatedAt: new Date(row.updatedAt), lastUsedAt: new Date(row.lastUsedAt) })));
	await db.getRepository(MiRoleAssignment).insert(corpus.assignments.map((row: { expiresAt: string | null }) => ({ ...row, expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt) })));
	await db.getRepository(MiAccessToken).update({ userId: seed.actors.readScope.id }, { permission: ['read:account'] });
	app = createBackendHttpApp(resources, database.config);
	server = await listenHttp(createRoleHttpApp(resources, database.config), { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	vi.spyOn(Date, 'now').mockReturnValue(corpus.atMs);
});
afterAll(async () => {
	vi.restoreAllMocks();
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

function inputFor(entry: { input: object; actor: string }) {
	const actor = { native: 'ordinary', scope: 'readScope', noScope: 'ordinaryNoScope', suspended: 'suspended' }[entry.actor];
	if (Array.isArray(entry.input)) {
		return entry.input;
	}
	return { ...entry.input, ...(actor ? { i: seed.actors[actor].token } : {}) };
}

test.each(corpus.cases as { id: string; endpoint: string; actor: string; input: object }[])('$id through listening HTTP and canonical product app', async entry => {
	const input = inputFor(entry);
	const http = await fetch(`${origin}/api/roles/${entry.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(entry.actor === 'native' ? { authorization: `Bearer ${seed.actors.ordinary.token}` } : {}) }, body: JSON.stringify(input) });
	const canonical = await app.request(`/api/roles/${entry.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(entry.actor === 'native' ? { authorization: `Bearer ${seed.actors.ordinary.token}` } : {}) }, body: JSON.stringify(input) });
	expect(canonical.status).toBe(http.status);
	const actual = await http.json();
	expect(await canonical.json()).toEqual(actual);
	const source = observations.cases.find((row: { id: string }) => row.id === entry.id);
	if (source) {
		expect({ status: http.status, body: actual }).toEqual({ status: source.status, body: source.body });
	} else {
		const errors: Record<string, [number, string]> = { 'list-anonymous': [401, 'CREDENTIAL_REQUIRED'], 'list-no-scope': [403, 'PERMISSION_DENIED'], 'list-suspended': [403, 'YOUR_ACCOUNT_SUSPENDED'] };
		if (entry.id === 'list-scope') {
			expect(http.status).toBe(200);
			expect(actual).toEqual(observations.cases.find((row: { id: string }) => row.id === 'list').body);
		} else {
			expect([http.status, actual.error.code]).toEqual(errors[entry.id]);
		}
	}
});

test('assignment expires at equality; existing admin conversion and UserDetailed materials share the same database facts', async () => {
	const reader = createRoleShowReader(resources.dataSource.manager, seed.codec.createdAtFromId);
	const id = corpus.roles[0].id;
	expect((await reader.readPublic(id, corpus.atMs - 1))?.assignedCount).toBe(3);
	expect((await reader.readPublic(id, corpus.atMs))?.assignedCount).toBe(2);
	expect((await reader.readPublic(id, corpus.atMs + 1))?.assignedCount).toBe(1);
	expect(await reader.readUserRoles(user({ userId }), corpus.atMs)).toEqual(observations.userRoles);
	expect(await reader.read(id, corpus.atMs)).toEqual(await reader.readPublic(id, corpus.atMs));
	expect(await resources.dataSource.getRepository(MiRoleAssignment).count()).toBe(corpus.assignments.length);
});

test('query failure propagates to HTTP 500 without successful partial output or writes', async () => {
	const db = resources.dataSource;
	const before = await db.getRepository(MiRole).find();
	const repository = db.getRepository(MiRoleAssignment);
	const fail = vi.spyOn(repository, 'createQueryBuilder').mockImplementation(() => {
		throw new Error('injected role count failure'); 
	});
	try {
		const response = await fetch(`${origin}/api/roles/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId: corpus.roles[0].id }) });
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
	} finally {
		fail.mockRestore();
	}
	expect(await db.getRepository(MiRole).find()).toEqual(before);
});
