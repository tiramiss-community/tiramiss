/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiMeta, MiModerationLog, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createLogger } from '../../src/platform/logger.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createDefaultRolePolicies } from '../../src/composition/default-role-policies.js';
import { createAccessRequest } from '../../src/modules/access/public.js';
import { createAttemptEvaluation, DEFAULT_POLICIES } from '../../src/modules/role/public.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { evaluationReader } from '../helpers/role-evaluation.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let remote: Awaited<ReturnType<typeof connectResources>>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: Server;
let base: string;
let subscriber: Redis;
const events: {
	type: string;
	body: unknown;
}[] = [];
const initial = { canInvite: false, driveCapacityMb: 55 };
const stored = () => resources.dataSource.getRepository(MiMeta).findOneByOrFail({ id: 'singleton' });
const audits = () => resources.dataSource.getRepository(MiModerationLog).findBy({ type: 'updateServerSettings' });
const call = (input: unknown, token: unknown = seeded.actors.root.token) => fetch(`${base}/api/admin/roles/update-default-policies`, {
	method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: token, ...input as object }),
});

async function effective(userId: string | null, runtime = resources) {
	const evaluation = createAttemptEvaluation(Date.now());
	try {
		return await evaluation.openSession(evaluationReader(runtime.dataSource, runtime.roleMaterials), 20 * 1024 * 1024).getEffectivePolicies(userId);
	} finally {
		evaluation.close();
	}
}

beforeAll(async () => {
	database = await createTestDatabase();
	// Internal host topics are global, so isolate them as well as the DB and private topics.
	database.config.url = `http://${database.config.database.database.replaceAll('_', '-')}.test`;
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('default-policies', () => { }));
	remote = await connectResources(database.config, createLogger('default-policies-remote', () => { }));
	seeded = await seedRoleHttp(resources.dataSource);
	subscriber = new Redis(database.config.redisForPubsub);
	await subscriber.subscribe(new URL(database.config.url).host);
	subscriber.on('message', (_topic, payload) => {
		const event = JSON.parse(payload);
		if (event.channel === 'internal') {
			events.push(event.message);
		}
	});
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	base = `http://127.0.0.1:${(server.address() as {
		port: number;
	}).port}`;
});
beforeEach(async () => {
	await resources.defaultRolePolicies.idle();
	await resources.dataSource.query('UPDATE meta SET policies = $1 WHERE id = $2', [JSON.stringify(initial), 'singleton']);
	await resources.dataSource.getRepository(MiModerationLog).deleteAll();
	await resources.meta.fetch(true);
	await remote.meta.fetch(true);
	events.length = 0;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	subscriber?.disconnect();
	await remote?.close();
	await resources?.close();
	await database?.close();
});
test.each([
	['ordinary', 403, 'ROLE_PERMISSION_DENIED'], ['moderator', 403, 'ROLE_PERMISSION_DENIED'],
	['expired', 403, 'ROLE_PERMISSION_DENIED'], ['ordinaryNoScope', 403, 'ROLE_PERMISSION_DENIED'],
	['suspended', 403, 'YOUR_ACCOUNT_SUSPENDED'], ['readScope', 403, 'PERMISSION_DENIED'],
	['invalid', 401, 'AUTHENTICATION_FAILED'],
] as const)('%s rejects before malformed input and leaves Meta/audit unchanged', async (actor, status, code) => {
	const response = await call({}, seeded.actors[actor].token);
	expect(response.status).toBe(status);
	expect(await response.json()).toHaveProperty('error.code', code);
	expect((await stored()).policies).toEqual(initial);
	expect(await audits()).toEqual([]);
});
test('anonymous credential and invalid input fail without side effects', async () => {
	expect((await call({}, null)).status).toBe(401);
	for (const policies of [undefined, null, [], 'bad', 1]) {
		const response = await call({ policies });
		expect(response.status).toBe(400);
		expect(await response.json()).toHaveProperty('error.code', 'INVALID_PARAM');
	}
	expect((await stored()).policies).toEqual(initial);
	expect(await audits()).toEqual([]);
	expect(events).toEqual([]);
});
test.each(['root', 'administrator', 'writeScope'])('%s replaces partial policy JSON, emits snapshots, and affects the next anonymous and normal-user operations', async (actor) => {
	const ordinary = seeded.actors.ordinary.id;
	expect(await effective(null, remote)).toMatchObject(initial);
	expect(await effective(ordinary, remote)).toMatchObject(initial);
	const policy = { canInvite: true, driveCapacityMb: 7, unknown: { nested: ['x'] } };
	const response = await call({ policies: policy }, seeded.actors[actor].token);
	expect(response.status).toBe(204);
	expect(await response.text()).toBe('');
	await resources.defaultRolePolicies.idle();
	expect((await stored()).policies).toEqual(policy);
	expect(await audits()).toMatchObject([{ userId: seeded.actors[actor].id, info: { before: initial, after: policy } }]);
	await vi.waitFor(() => expect(events.map(event => event.type)).toEqual(['metaUpdated', 'policiesUpdated']));
	expect(events[0].body).toMatchObject({ before: { policies: initial }, after: { policies: policy } });
	expect(events[1].body).toEqual(policy);
	await vi.waitFor(async () => expect((await remote.meta.fetch()).policies).toEqual(policy));
	for (const runtime of [resources, remote]) {
		for (const userId of [null, ordinary]) {
			expect(await effective(userId, runtime)).toMatchObject({ canInvite: true, driveCapacityMb: 7, mentionLimit: DEFAULT_POLICIES.mentionLimit });
		}
	}
});
test('empty policies restore defaults and do not merge previous overrides', async () => {
	expect((await call({ policies: {} })).status).toBe(204);
	expect((await stored()).policies).toEqual({});
	expect(await effective(null)).toEqual(DEFAULT_POLICIES);
	expect(await effective(seeded.actors.ordinary.id)).toMatchObject({ canInvite: DEFAULT_POLICIES.canInvite, driveCapacityMb: DEFAULT_POLICIES.driveCapacityMb });
});
test('arbitrary entry values remain raw in storage and anonymous evaluation but normal evaluation keeps source coercion', async () => {
	const policy = { canInvite: 'yes', driveCapacityMb: '7', unknown: null };
	expect((await call({ policies: policy })).status).toBe(204);
	expect((await stored()).policies).toEqual(policy);
	expect(await effective(null)).toMatchObject(policy);
	expect(await effective(seeded.actors.ordinary.id)).toMatchObject({ canInvite: false, driveCapacityMb: 7 });
});
test('database failure leaves Meta, warmed caches, audit and notifications unchanged', async () => {
	await resources.dataSource.query('ALTER TABLE meta ADD CONSTRAINT default_policy_failure CHECK (NOT policies ? \'fail\')');
	try {
		const response = await call({ policies: { fail: true } });
		expect(response.status).toBe(500);
		expect((await stored()).policies).toEqual(initial);
		expect(await audits()).toEqual([]);
		expect(events).toEqual([]);
		expect((await resources.meta.fetch()).policies).toEqual(initial);
		expect((await remote.meta.fetch()).policies).toEqual(initial);
	} finally {
		await resources.dataSource.query('ALTER TABLE meta DROP CONSTRAINT default_policy_failure');
	}
});
test('audit failure after save is diagnosed without undoing the successful update', async () => {
	await resources.dataSource.query('ALTER TABLE moderation_log ADD CONSTRAINT default_policy_audit_failure CHECK (type <> \'updateServerSettings\')');
	try {
		expect((await call({ policies: {} })).status).toBe(204);
		await resources.defaultRolePolicies.idle();
		expect((await stored()).policies).toEqual({});
		expect(await audits()).toEqual([]);
	} finally {
		await resources.dataSource.query('ALTER TABLE moderation_log DROP CONSTRAINT default_policy_audit_failure');
	}
});
test('current DB role revocation denies an administrator despite warmed role cache', async () => {
	await resources.roleMaterials.readRoles();
	await resources.roleMaterials.readAssignments(seeded.actors.administrator.id);
	await resources.dataSource.getRepository(MiRoleAssignment).delete({ userId: seeded.actors.administrator.id });
	expect((await call({ policies: {} }, seeded.actors.administrator.token)).status).toBe(403);
	expect((await stored()).policies).toEqual(initial);
});
test('suspended root is rejected before invalid input', async () => {
	await resources.dataSource.getRepository(MiUser).update(seeded.actors.root.id, { isSuspended: true });
	try {
		expect((await (await call({})).json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update(seeded.actors.root.id, { isSuspended: false });
	}
});
test('uses the newest Meta row and leaves older duplicate rows intact', async () => {
	const old = await stored();
	await resources.dataSource.getRepository(MiMeta).insert({ ...old, id: 'z' });
	try {
		expect((await call({ policies: { driveCapacityMb: 9 } })).status).toBe(204);
		expect((await resources.dataSource.getRepository(MiMeta).findOneByOrFail({ id: 'z' })).policies).toEqual({ driveCapacityMb: 9 });
		expect((await stored()).policies).toEqual(initial);
	} finally {
		await resources.defaultRolePolicies.idle();
		await resources.dataSource.getRepository(MiMeta).delete('z');
	}
});
test('creates default Meta when absent and persists policies for the current administrator', async () => {
	const original = await stored();
	await resources.dataSource.getRepository(MiMeta).deleteAll();
	try {
		expect((await call({ policies: {} }, seeded.actors.suspended.token)).status).toBe(403);
		// Qualification reads create x in the same way as the source Meta service.
		expect((await call({ policies: {} }, seeded.actors.writeScope.token)).status).toBe(403);
		const roleId = seeded.codec.newId(Date.now());
		const { MiRole } = await import('backend-upstream/entities');
		await resources.dataSource.getRepository(MiRole).insert({ id: roleId, name: 'restore-admin', description: '', isAdministrator: true, updatedAt: new Date(), lastUsedAt: new Date() });
		await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: seeded.codec.newId(Date.now()), roleId, userId: seeded.actors.root.id });
		expect((await call({ policies: {} })).status).toBe(204);
		expect((await resources.dataSource.getRepository(MiMeta).findOneByOrFail({ id: 'x' })).policies).toEqual({});
		await resources.dataSource.getRepository(MiRoleAssignment).delete({ roleId });
		await resources.dataSource.getRepository(MiRole).delete(roleId);
	} finally {
		await resources.defaultRolePolicies.idle();
		await resources.dataSource.getRepository(MiMeta).deleteAll();
		await resources.dataSource.getRepository(MiMeta).insert(original);
	}
});
test('non-awaited audit can finish after HTTP while close waits for the started write', async () => {
	const runner = resources.dataSource.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	await runner.query('LOCK TABLE moderation_log IN ACCESS EXCLUSIVE MODE');
	try {
		const response = await call({ policies: {} });
		expect(response.status).toBe(204);
		let drained = false;
		const closing = resources.defaultRolePolicies.close().then(() => {
			drained = true;
		});
		await vi.waitFor(async () => {
			const blocked = await resources.dataSource.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%moderation_log%'");
			expect(blocked.length).toBeGreaterThan(0);
		});
		expect(drained).toBe(false);
		await runner.commitTransaction();
		await closing;
		expect(drained).toBe(true);
		expect(await audits()).toHaveLength(1);
	} finally {
		if (runner.isTransactionActive) {
			await runner.rollbackTransaction();
		}
		await runner.release();
	}
});
test('post-commit publish failures are diagnosed and cannot undo the saved policy or audit', async () => {
	const logger = { info: vi.fn(), error: vi.fn((_message: string, _fields?: unknown) => {
		throw new Error('diagnostics unavailable');
	}) };
	const publisher = { publish: vi.fn().mockRejectedValue(new Error('notification unavailable')) };
	const application = createDefaultRolePolicies({ dataSource: resources.dataSource, meta: resources.meta, publisher, logger, ids: seeded.codec, url: database.config.url });
	await application.updateDefaultPolicies(createAccessRequest({ requireCredential: true, requireAdmin: true, kind: 'write:admin:roles' }, { userId: seeded.actors.root.id, native: true }), { policies: {} });
	await application.close();
	expect((await stored()).policies).toEqual({});
	expect(await audits()).toHaveLength(1);
	expect(publisher.publish).toHaveBeenCalledTimes(2);
	expect(logger.error.mock.calls.map(call => call[1])).toEqual([
		{ stage: 'metaUpdated', error: expect.any(Error) }, { stage: 'policiesUpdated', error: expect.any(Error) },
	]);
});
