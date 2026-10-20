/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiAccessToken, MiModerationLog, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createRoleHttpApp } from '../../src/composition/role-http.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { Server } from 'node:http';

interface HttpCase { name: string; endpoint: 'show' | 'update'; actor: string; params?: object; status: number; code?: string; id?: string; message?: string; kind?: string; info?: object; wwwAuthenticate?: string }
const cases: HttpCase[] = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/role/http-cases.json', import.meta.url), 'utf8'));
const intentional: { name: string; endpoints: string[]; params: object; nextExpected: { status: number; bodyText: string } }[] = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/role/intentional-http-cases.json', import.meta.url), 'utf8'));

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: Server;
let base: string;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

async function call(endpoint: string, input: unknown, token: unknown = seeded.actors.root.token, authorization?: string, method = 'POST') {
	return fetch(`${base}/api/admin/roles/${endpoint}`, { method, headers: { 'Content-Type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: method === 'GET' ? undefined : JSON.stringify({ roleId: seeded.roleId, ...(input as object), i: token }) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('test', () => {}));
	seeded = await seedRoleHttp(resources.dataSource);
	server = await listenHttp(createRoleHttpApp(resources, database.config), { port: 0 });
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

test.each(cases)('$name matches pinned upstream response and write side effects', async entry => {
	const { dataSource: db } = resources;
	const before = await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId });
	const auditBefore = await db.getRepository(MiModerationLog).count();
	const response = await call(entry.endpoint, entry.params ?? {}, seeded.actors[entry.actor]?.token ?? null);
	expect(response.status).toBe(entry.status);
	if (entry.code) {
		expect(await response.json()).toEqual({ error: { code: entry.code, id: entry.id, message: entry.message, kind: entry.kind, ...(entry.info ? { info: entry.info } : {}) } });
		expect(response.headers.get('www-authenticate')).toBe(entry.wwwAuthenticate ?? null);
		expect(await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId })).toEqual(before);
		expect(await db.getRepository(MiModerationLog).count()).toBe(auditBefore);
	} else if (entry.status === 200) {
		const output = await response.json();
		expect(output).toMatchObject({ id: seeded.roleId, name: 'target', description: 'keep', usersCount: 0 });
		const defaults = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/role/policy-defaults.json', import.meta.url), 'utf8'));
		for (const [key, value] of Object.entries(defaults)) {
			expect(output.policies[key]).toEqual({ useDefault: true, priority: 0, value });
		}
	} else {
		expect(await response.text()).toBe('');
		expect(await db.getRepository(MiModerationLog).count()).toBe(auditBefore + 1);
	}
});

test('Bearer overrides body without fallback, while non-Bearer uses body', async () => {
	expect((await call('show', {}, seeded.actors.invalid.token, `Bearer ${seeded.actors.root.token}`)).status).toBe(200);
	expect((await call('show', {}, seeded.actors.root.token, `Bearer ${seeded.actors.invalid.token}`)).status).toBe(401);
	expect((await call('show', {}, seeded.actors.root.token, 'bearer invalid')).status).toBe(200);
});
test.each(intentional.flatMap(entry => entry.endpoints.map(endpoint => ({ ...entry, endpoint }))))('$endpoint: $name matches approved intentional fixture', async entry => {
	const response = await fetch(`${base}/api/admin/roles/${entry.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId: seeded.roleId, ...entry.params }) });
	expect(response.status).toBe(entry.nextExpected.status);
	expect(await response.text()).toBe(entry.nextExpected.bodyText);
});
test.each([false, {}, []])('completes other non-string credential %j as 400 empty', async token => {
	const response = await call('show', {}, token);
	expect(response.status).toBe(400);
	expect(await response.text()).toBe('');
});
test('rejects GET with empty 405 but accepts PUT under the same authentication contract', async () => {
	const response = await call('show', {}, null, undefined, 'GET');
	expect(response.status).toBe(405);
	expect(await response.text()).toBe('');
	expect((await call('show', {}, seeded.actors.root.token, undefined, 'PUT')).status).toBe(200);
});
test.each(['show', 'update'])('%s checks qualification and scope before invalid input', async endpoint => {
	const denied = await call(endpoint, { roleId: '!', name: null }, seeded.actors.ordinaryNoScope.token);
	expect((await denied.json()).error.code).toBe('ROLE_PERMISSION_DENIED');
	const scope = await call(endpoint, { roleId: '!', name: null }, seeded.actors[endpoint === 'show' ? 'writeScope' : 'readScope'].token);
	expect((await scope.json()).error.code).toBe('PERMISSION_DENIED');
});
test('partial update keeps unknown JSON, exact audit snapshots, nulls and no-op timestamps', async () => {
	const db = resources.dataSource;
	const before = await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId });
	const policies = { unknown: { value: null }, canInvite: null };
	const response = await call('update', { name: 'changed', color: null, policies, condFormula: { unknown: true }, ignored: 'never persisted' });
	expect(response.status).toBe(204);
	expect(await response.text()).toBe('');
	const after = await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId });
	expect(after).toMatchObject({ name: 'changed', description: 'keep', color: null, policies, condFormula: { unknown: true }, lastUsedAt: before.lastUsedAt });
	const logs = await db.getRepository(MiModerationLog).find({ order: { id: 'DESC' } });
	expect(logs[0].info).toEqual({ roleId: seeded.roleId, before: json(before), after: json(after) });
	const output = await (await call('show', {})).json();
	expect(Object.keys(output).sort()).toEqual(['id', 'createdAt', 'updatedAt', 'name', 'description', 'color', 'iconUrl', 'target', 'condFormula', 'isPublic', 'isAdministrator', 'isModerator', 'isExplorable', 'asBadge', 'preserveAssignmentOnMoveAccount', 'canEditMembersByModerator', 'displayOrder', 'policies', 'usersCount'].sort());
	expect(output.createdAt).toBe(new Date(seeded.codec.createdAtFromId(seeded.roleId)).toISOString());
	expect(output.policies.unknown).toEqual({ value: null });
	expect(output.policies.canInvite).toEqual({ useDefault: true, priority: 0, value: false });
	expect((await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId })).policies).toEqual(policies);
	expect((await call('update', {})).status).toBe(204);
	expect((await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId })).updatedAt.getTime()).toBeGreaterThan(after.updatedAt.getTime());
});
test('counts only active assigned rows, regardless of conditional matches', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiRoleAssignment).insert([
		{ id: seeded.codec.newId(Date.now()), roleId: seeded.roleId, userId: seeded.actors.ordinary.id, expiresAt: null },
		{ id: seeded.codec.newId(Date.now()), roleId: seeded.roleId, userId: seeded.actors.expired.id, expiresAt: new Date(0) },
	]);
	expect((await call('update', { target: 'conditional', condFormula: { type: 'isLocal' } })).status).toBe(204);
	expect((await (await call('show', {})).json()).usersCount).toBe(1);
});
test('updates access-token usage without using token permissions in place of App permissions', async () => {
	expect((await call('show', {}, seeded.actors.appRead.token)).status).toBe(200);
	expect((await resources.dataSource.getRepository(MiAccessToken).findOneByOrFail({ hash: 'app-hash-probe-120' })).lastUsedAt).toBeInstanceOf(Date);
	expect((await call('show', {}, 'app-token-probe-120')).status).toBe(200);
});
test('rejects revoked administrator DB facts despite warmed material cache', async () => {
	const db = resources.dataSource;
	await resources.roleMaterials.readRoles();
	await resources.roleMaterials.readAssignments(seeded.actors.administrator.id);
	await db.getRepository(MiRoleAssignment).delete({ userId: seeded.actors.administrator.id });
	expect((await call('update', { isAdministrator: true }, seeded.actors.administrator.token)).status).toBe(403);
});
test('suspended root is rejected before scope and malformed input', async () => {
	await resources.dataSource.getRepository(MiUser).update(seeded.actors.root.id, { isSuspended: true });
	try {
		const response = await call('update', { roleId: '!' });
		expect((await response.json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update(seeded.actors.root.id, { isSuspended: false });
	}
});

test.each([{ displayOrder: 1.5 }, { name: 'x'.repeat(257) }])('keeps DB constraint failures as 500 and rolls back audit for %j', async input => {
	const db = resources.dataSource;
	const before = await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId });
	const count = await db.getRepository(MiModerationLog).count();
	const response = await call('update', input);
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ error: { message: 'Internal error occurred. Please contact us if the error persists.', code: 'INTERNAL_ERROR', id: '5d37dbcb-891e-41ca-a3d6-e690c97775ac', kind: 'server' } });
	expect(await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId })).toEqual(before);
	expect(await db.getRepository(MiModerationLog).count()).toBe(count);
});
test('show count excludes assignments expiring exactly at its evaluation timestamp', async () => {
	const { createRoleShowReader } = await import('../../src/platform/database/role-show.js');
	const db = resources.dataSource;
	const at = Date.now();
	await db.getRepository(MiRoleAssignment).delete({ roleId: seeded.roleId });
	await db.getRepository(MiRoleAssignment).insert([
		{ id: seeded.codec.newId(at), roleId: seeded.roleId, userId: seeded.actors.ordinary.id, expiresAt: new Date(at) },
		{ id: seeded.codec.newId(at), roleId: seeded.roleId, userId: seeded.actors.expired.id, expiresAt: new Date(at + 1) },
	]);
	expect((await createRoleShowReader(db.manager, seeded.codec.createdAtFromId).read(seeded.roleId, at))?.assignedCount).toBe(1);
});

test.each([false, true])('rejects bodies above 1 MiB before authentication or writes (chunked=%s)', async chunked => {
 const db = resources.dataSource;
 const count = await db.getRepository(MiModerationLog).count();
 const before = await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId });
 const body = JSON.stringify({ roleId: seeded.roleId, i: seeded.actors.writeScope.token, padding: 'x'.repeat(1024 * 1024) });
 const tokenBefore = await db.getRepository(MiAccessToken).findOneByOrFail({ token: seeded.actors.writeScope.token });
 const response = await new Promise<number | undefined>((resolve, reject) => {
  const req = request(`${base}/api/admin/roles/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
   res.resume();
   expect(res.headers.connection).toBe('close');
   res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  if (chunked) {
   req.write(body.slice(0, 4096));
   req.end(body.slice(4096));
  } else {
   req.end(body);
  }
 });
 expect(response).toBe(413);
 expect(await db.getRepository(MiModerationLog).count()).toBe(count);
 expect(await db.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId })).toEqual(before);
 expect((await db.getRepository(MiAccessToken).findOneByOrFail({ token: seeded.actors.writeScope.token })).lastUsedAt).toEqual(tokenBefore.lastUsedAt);
});
test('accepts exactly 1 MiB of JSON', async () => {
 const input = { roleId: seeded.roleId, i: seeded.actors.root.token, padding: '' };
 input.padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(input)));
 const body = JSON.stringify(input);
 expect(Buffer.byteLength(body)).toBe(1024 * 1024);
 const response = await fetch(`${base}/api/admin/roles/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
 expect(response.status).toBe(200);
});

test.each([
 ['show', 'ordinary', 403, 'ROLE_PERMISSION_DENIED'],
 ['update', 'ordinaryNoScope', 403, 'ROLE_PERMISSION_DENIED'],
 ['show', 'suspended', 403, 'YOUR_ACCOUNT_SUSPENDED'],
 ['update', 'suspended', 403, 'YOUR_ACCOUNT_SUSPENDED'],
 ['show', 'writeScope', 403, 'PERMISSION_DENIED'],
 ['update', 'readScope', 403, 'PERMISSION_DENIED'],
 ['show', 'root', 200, null],
 ['update', 'root', 204, null],
] as const)('ignores deeply nested unknown fields after %s authorization for %s', async (endpoint, actor, status, code) => {
 const nested = '{"value":'.repeat(5000) + '0' + '}'.repeat(5000);
 const body = JSON.stringify({ roleId: seeded.roleId, i: seeded.actors[actor].token }).slice(0, -1) + ',"ignored":' + nested + '}';
 const response = await fetch(`${base}/api/admin/roles/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
 expect(response.status).toBe(status);
 if (code) {
  expect((await response.json()).error.code).toBe(code);
 }
});
test.each(['show', 'update'])('%s does not let a deep known input preempt qualification', async endpoint => {
 const nested = '{"value":'.repeat(5000) + '0' + '}'.repeat(5000);
 const body = JSON.stringify({ roleId: seeded.roleId, i: seeded.actors.ordinary.token }).slice(0, -1) + ',"policies":' + nested + '}';
 const response = await fetch(`${base}/api/admin/roles/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
 expect(response.status).toBe(403);
 expect((await response.json()).error.code).toBe('ROLE_PERMISSION_DENIED');
});
