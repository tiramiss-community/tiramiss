/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiMeta, MiModerationLog, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createAttemptEvaluation, createRequestEvaluation } from '../../src/modules/role/public.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createRoleHttpApp } from '../../src/composition/role-http.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createRoleMaterialReader } from '../../src/platform/database/role-materials.js';
import { openRoleMaterials } from '../../src/platform/role-materials.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { evaluationReader } from '../helpers/role-evaluation.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import type { Server } from 'node:http';
import type { RoleFactsReader, RolePolicies } from '../../src/modules/role/public.js';

const flow: { name: string; patch: object; expected: Partial<RolePolicies> }[] = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/role/policy-flow-cases.json', import.meta.url), 'utf8'));
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let local: Awaited<ReturnType<typeof connectResources>>;
let remote: Awaited<ReturnType<typeof connectResources>>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: Server;
let base: string;
let localReader: RoleFactsReader;
let remoteReader: RoleFactsReader;

async function effective(reader: RoleFactsReader, at = Date.now()) {
	const boundary = createAttemptEvaluation(at);
	try {
		return await boundary.openSession(reader, 20 * 1024 * 1024).getEffectivePolicies(seeded.actors.ordinary.id);
	} finally {
		boundary.close();
	}
}

async function update(patch: object, token = seeded.actors.root.token, url = base) {
	return fetch(`${url}/api/admin/roles/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId: seeded.roleId, ...patch, i: token }) });
}

const stored = () => local.dataSource.getRepository(MiRole).findOneByOrFail({ id: seeded.roleId });
const audits = () => local.dataSource.getRepository(MiModerationLog).find({ order: { id: 'ASC' } });

beforeAll(async () => {
	database = await createTestDatabase();
	const prefix = `role121-${randomUUID()}`;
	for (const redis of [database.config.redis, database.config.redisForPubsub, database.config.redisForJobQueue]) {
		redis.prefix = prefix;
	}
	await migrateDatabase(database.config.database);
	local = await connectResources(database.config, createLogger('test', () => {}));
	remote = await connectResources(database.config, createLogger('test', () => {}));
	server = await listenHttp(createRoleHttpApp(local, database.config), { port: 0 });
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	localReader = evaluationReader(local.dataSource, local.roleMaterials);
	remoteReader = evaluationReader(remote.dataSource, remote.roleMaterials);
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await remote?.close();
	await local?.close();
	await database?.close();
});
beforeEach(async () => {
	const db = local.dataSource;
	await db.query('ALTER TABLE moderation_log DROP CONSTRAINT IF EXISTS role_acceptance_audit_failure');
	await db.getRepository(MiRoleAssignment).deleteAll();
	await db.getRepository(MiModerationLog).deleteAll();
	await db.getRepository(MiRole).deleteAll();
	await db.getRepository(MiUser).deleteAll();
	await db.getRepository(MiMeta).deleteAll();
	seeded = await seedRoleHttp(db);
	await db.query('UPDATE meta SET policies = $1', [JSON.stringify({ canInvite: false, driveCapacityMb: 55 })]);
	await db.getRepository(MiRoleAssignment).insert({ id: seeded.codec.newId(Date.now()), roleId: seeded.roleId, userId: seeded.actors.ordinary.id, expiresAt: null });
	const event = { kind: 'role-definitions-changed' as const, roleId: seeded.roleId };
	local.roleMaterials.changes.invalidateLocal(event);
	remote.roleMaterials.changes.invalidateLocal(event);
});

test('real token HTTP updates match the shared upstream policy flow in subsequent local and remote operations', async () => {
	const active = createRequestEvaluation(Date.now);
	const session = active.openSession(remoteReader, 20 * 1024 * 1024);
	try {
		expect((await session.getEffectivePolicies(seeded.actors.ordinary.id)).canInvite).toBe(false);
		expect(await effective(localReader)).toMatchObject({ canInvite: false, driveCapacityMb: 55 });
		for (const entry of flow) {
			const before = await stored();
			const count = (await audits()).length;
			expect((await update(entry.patch)).status, entry.name).toBe(204);
			const after = await stored();
			expect(after.policies).toEqual((entry.patch as { policies: unknown }).policies);
			const logs = await audits();
			expect(logs).toHaveLength(count + 1);
			expect(logs.at(-1)).toMatchObject({ userId: seeded.actors.root.id, type: 'updateRole', info: { roleId: seeded.roleId, before: json(before), after: json(after) } });
			expect(await effective(localReader)).toMatchObject(entry.expected);
			await vi.waitFor(async () => expect(await effective(remoteReader)).toMatchObject(entry.expected));
			expect((await session.getEffectivePolicies(seeded.actors.ordinary.id)).canInvite).toBe(false);
		}
	} finally {
		active.close();
	}
});

test('HTTP audit storage failure rolls back both writes and leaves warmed policies unchanged', async () => {
	const before = await stored();
	expect((await effective(remoteReader)).canInvite).toBe(false);
	await local.dataSource.query("ALTER TABLE moderation_log ADD CONSTRAINT role_acceptance_audit_failure CHECK (type <> 'updateRole')");
	try {
		const response = await update(flow[0].patch);
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
		expect(await stored()).toEqual(before);
		expect(await audits()).toEqual([]);
		expect((await effective(localReader)).canInvite).toBe(false);
		expect((await effective(remoteReader)).canInvite).toBe(false);
	} finally {
		await local.dataSource.query('ALTER TABLE moderation_log DROP CONSTRAINT role_acceptance_audit_failure');
	}
});

test('HTTP cannot authorize self promotion using the requested administrator flag', async () => {
	const before = await stored();
	expect((await update({ isAdministrator: true }, seeded.actors.ordinary.token)).status).toBe(403);
	expect(await stored()).toEqual(before);
	expect(await audits()).toEqual([]);
});

test('assignment expiry uses the operation time independently of a warm real DB material cache', async () => {
	const expiry = Date.now();
	await local.dataSource.getRepository(MiRoleAssignment).update({ roleId: seeded.roleId, userId: seeded.actors.ordinary.id }, { expiresAt: new Date(expiry) });
	expect((await update(flow[0].patch)).status).toBe(204);
	let time = expiry - 1;
	const boundary = createRequestEvaluation(() => time);
	try {
		const session = boundary.openSession(remoteReader, 20 * 1024 * 1024);
		expect((await session.getEffectivePolicies(seeded.actors.ordinary.id)).canInvite).toBe(true);
		time = expiry;
		expect((await session.getEffectivePolicies(seeded.actors.ordinary.id)).canInvite).toBe(true);
		expect((await effective(remoteReader, time)).canInvite).toBe(false);
		expect(await local.dataSource.getRepository(MiRoleAssignment).countBy({ roleId: seeded.roleId })).toBe(1);
	} finally {
		boundary.close();
	}
});

test('actual post-commit pre-publish process death preserves writes and recovers missed notification at TTL', async () => {
	let time = 0;
	const materials = await openRoleMaterials({ source: createRoleMaterialReader(remote.dataSource.manager), publisher: remote.redis,
		subscriberConfig: database.config.redisForPubsub, config: { rolesTtlMs: 100, assignmentsTtlMs: 1000, assignmentsMaxEntries: 10 }, clock: () => time });
	const reader = evaluationReader(remote.dataSource, materials);
	const boundary = createRequestEvaluation(Date.now);
	const session = boundary.openSession(reader, 20 * 1024 * 1024);
	const port = await freePort();
	const config = await configuration({ ...database.config, http: { port } });
	const child = launch('test/fixtures/role-before-publish.mjs', config.path);
	try {
		expect((await session.getEffectivePolicies(seeded.actors.ordinary.id)).canInvite).toBe(false);
		await child.ready;
		const before = await stored();
		const result = update(flow[0].patch, seeded.actors.root.token, `http://127.0.0.1:${port}`).then(response => response.status, () => 'disconnected');
		await vi.waitFor(() => expect(child.messages).toContainEqual({ type: 'before-publish' }), { timeout: 10000 });
		child.child.kill('SIGKILL');
		expect((await child.exit).signal).toBe('SIGKILL');
		expect(await result).toBe('disconnected');
		const after = await stored();
		expect(after.policies).toEqual((flow[0].patch as { policies: unknown }).policies);
		expect(await audits()).toMatchObject([{ info: { roleId: seeded.roleId, before: json(before), after: json(after) } }]);
		time = 99;
		expect((await effective(reader)).canInvite).toBe(false);
		time = 100;
		expect(await effective(reader)).toMatchObject(flow[0].expected);
		expect((await session.getEffectivePolicies(seeded.actors.ordinary.id)).canInvite).toBe(false);
	} finally {
		boundary.close();
		await child.close();
		await config.close();
		await materials.close();
	}
});
