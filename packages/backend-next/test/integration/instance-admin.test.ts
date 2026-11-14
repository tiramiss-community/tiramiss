/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiAccessToken, MiInstance, MiModerationLog } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import { deferred } from '../helpers/remote-peer.js';
import { startMetadataPeer, metadataReply, expectedMetadata } from '../helpers/instance-metadata-peer.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
let peer: Awaited<ReturnType<typeof startMetadataPeer>>;
let server: Server;
let origin: string;
let instanceId: string;
const logs: string[] = [];
const cacheKey = 'kvcache:federatedInstance:remote.test';
const lockKey = 'fetchInstanceMetadata:mutex:v2:remote.test';
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	peer = await startMetadataPeer();
	database.config.outboundHttp.proxy = peer.proxy;
	resources = await connectResources(database.config, createLogger('instance-admin-test', line => logs.push(line)));
	seed = await seedRoleHttp(resources.dataSource);
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: seed.codec.newId(Date.now()), userId: seed.actors.root.id, token: 'instance-admin-scope-362', hash: 'instance-admin-hash-362', permission: ['write:admin:federation'] });
	instanceId = seed.codec.newId(Date.now());
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
	peer.requests.length = 0;
	peer.respond(async path => metadataReply(path));
	logs.length = 0;
	await resources.dataSource.getRepository(MiModerationLog).clear();
	await resources.dataSource.getRepository(MiInstance).delete({ id: instanceId });
	await resources.dataSource.getRepository(MiInstance).insert({ id: instanceId, host: 'remote.test', firstRetrievedAt: new Date(), moderationNote: 'before' });
	await resources.redis.del(cacheKey, lockKey);
});
afterEach(async () => {
 await resources?.instanceAdministration.idle(); vi.restoreAllMocks(); 
});
afterAll(async () => {
 await closeHttp(server); await resources?.close(); await peer?.close(); await database?.close(); 
});

function post(operation: 'update-instance' | 'refresh-remote-instance-metadata', input: object, token: string | null = seed.actors.moderator.token, bearer?: string) {
	return fetch(`${origin}/api/admin/federation/${operation}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
		body: JSON.stringify({ ...(token === null ? {} : { i: token }), ...input }),
	});
}

const row = () => resources.dataSource.getRepository(MiInstance).findOneByOrFail({ id: instanceId });
const audits = () => resources.dataSource.getRepository(MiModerationLog).find({ order: { id: 'ASC' } });

test('real moderator HTTP saves suspension/note and whole-row Redis cache, then records separate audit entries', async () => {
	const response = await post('update-instance', { host: 'REMOTE.TEST', isSuspended: true, moderationNote: 'after' });
	expect(response.status, await response.clone().text()).toBe(204);
	expect(await response.text()).toBe('');
	await resources.instanceAdministration.idle();
	expect(await row()).toMatchObject({ suspensionState: 'manuallySuspended', moderationNote: 'after' });
	expect(JSON.parse((await resources.redis.get(cacheKey))!)).toMatchObject({ id: instanceId, suspensionState: 'manuallySuspended', moderationNote: 'after' });
	expect((await audits()).map(a => ({ userId: a.userId, type: a.type, info: a.info }))).toEqual([
		{ userId: seed.actors.moderator.id, type: 'suspendRemoteInstance', info: { id: instanceId, host: 'remote.test' } },
		{ userId: seed.actors.moderator.id, type: 'updateRemoteInstanceNote', info: { id: instanceId, host: 'remote.test', before: 'before', after: 'after' } },
	]);
	expect(peer.requests).toEqual([]);
});

for (const state of ['manuallySuspended', 'goneSuspended', 'autoSuspendedForNotResponding'] as const) {
	test(`effective suspension keeps ${state} and an explicit false clears it`, async () => {
		await resources.dataSource.getRepository(MiInstance).update(instanceId, { suspensionState: state });
		expect((await post('update-instance', { host: 'remote.test', isSuspended: true, moderationNote: 'before' })).status).toBe(204);
		await resources.instanceAdministration.idle();
		expect((await row()).suspensionState).toBe(state);
		expect(await audits()).toEqual([]);
		expect((await post('update-instance', { host: 'remote.test', isSuspended: false })).status).toBe(204);
		await resources.instanceAdministration.idle();
		expect((await row()).suspensionState).toBe('none');
		expect((await audits()).map(a => a.type)).toEqual(['unsuspendRemoteInstance']);
	});
}

for (const operation of ['update-instance', 'refresh-remote-instance-metadata'] as const) {
	for (const [actor, status, code] of [
		['guest', 401, 'CREDENTIAL_REQUIRED'], ['invalid', 401, 'AUTHENTICATION_FAILED'], ['ordinary', 403, 'ROLE_PERMISSION_DENIED'],
		['suspended', 403, 'YOUR_ACCOUNT_SUSPENDED'], ['expired', 403, 'ROLE_PERMISSION_DENIED'], ['readScope', 403, 'PERMISSION_DENIED'],
	] as const) {
		test(`${operation}: ${actor} rejects before input and leaves database/cache/network unchanged`, async () => {
			const response = await post(operation, { host: 10, moderationNote: 'after' }, actor === 'guest' ? null : seed.actors[actor].token);
			expect(response.status).toBe(status);
			expect(await response.json()).toHaveProperty('error.code', code);
			expect(await row()).toMatchObject({ suspensionState: 'none', moderationNote: 'before' });
			expect(await audits()).toEqual([]);
			expect(await resources.redis.get(cacheKey)).toBeNull();
			expect(peer.requests).toEqual([]);
		});
	}
	test(`${operation}: validates authorized input and missing hosts never register`, async () => {
		for (const input of [{}, { host: null }, { host: 1 }, ...(operation === 'update-instance' ? [{ host: 'remote.test', isSuspended: null }, { host: 'remote.test', moderationNote: null }] : [])]) {
			const response = await post(operation, input);
			expect(response.status).toBe(400);
			expect(await response.json()).toHaveProperty('error.code', 'INVALID_PARAM');
		}
		for (const host of ['missing.test', 'remote.test.', 'remote.test:3000']) {
			const response = await post(operation, { host, moderationNote: 'after' });
			expect(response.status).toBe(500);
			expect(await response.json()).toHaveProperty('error.info.e.message', 'instance not found');
		}
		expect(await resources.dataSource.getRepository(MiInstance).count()).toBe(1);
		expect(peer.requests).toEqual([]);
	});
}

test('host-only and unchanged suspension-only preserve upstream empty-update failure; same note is a defined successful update', async () => {
	for (const input of [{ host: 'remote.test' }, { host: 'remote.test', isSuspended: false }]) {
		expect((await post('update-instance', input)).status).toBe(500);
	}
	expect(await audits()).toEqual([]);
	expect((await post('update-instance', { host: 'remote.test', moderationNote: 'before' })).status).toBe(204);
	await resources.instanceAdministration.idle();
	expect(await audits()).toEqual([]);
});

test('IDN normalization, administrator and scoped token work; Bearer takes precedence over native body token', async () => {
	await resources.dataSource.getRepository(MiInstance).update(instanceId, { host: 'xn--r8jz45g.test' });
	expect((await post('update-instance', { host: '例え.TEST', moderationNote: 'idn' }, seed.actors.administrator.token)).status).toBe(204);
	expect((await post('update-instance', { host: '例え.TEST', moderationNote: 'scoped' }, 'instance-admin-scope-362')).status).toBe(204);
	const denied = await post('update-instance', { host: '例え.TEST', moderationNote: 'denied' }, seed.actors.root.token, seed.actors.readScope.token);
	expect(denied.status).toBe(403);
	expect((await row()).moderationNote).toBe('scoped');
});

test('DB failure leaves data/cache/audit unchanged', async () => {
	await resources.dataSource.query("CREATE FUNCTION instance_admin_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'update rejected'; END $$");
	await resources.dataSource.query('CREATE TRIGGER instance_admin_reject BEFORE UPDATE ON instance FOR EACH ROW EXECUTE FUNCTION instance_admin_reject()');
	try {
		expect((await post('update-instance', { host: 'remote.test', isSuspended: true, moderationNote: 'after' })).status).toBe(500);
		expect(await row()).toMatchObject({ suspensionState: 'none', moderationNote: 'before' });
		expect(await resources.redis.get(cacheKey)).toBeNull();
		expect(await audits()).toEqual([]);
	} finally {
		await resources.dataSource.query('DROP TRIGGER instance_admin_reject ON instance');
		await resources.dataSource.query('DROP FUNCTION instance_admin_reject()');
	}
});

test('held then rejected Redis cache write does not delay HTTP/audits or undo persisted state; idle drains it', async () => {
	const entered = deferred(); const release = deferred();
	const realSet = resources.redis.set.bind(resources.redis);
	vi.spyOn(resources.redis, 'set').mockImplementation(((...args: unknown[]) => {
		if (args[0] === cacheKey) {
			entered.resolve(); return release.promise.then(() => {
 throw Error('cache rejected'); 
});
		}
		return Reflect.apply(realSet, resources.redis, args);
	}) as typeof resources.redis.set);
	try {
		const response = await post('update-instance', { host: 'remote.test', moderationNote: 'after' });
		expect(response.status).toBe(204);
		await entered.promise;
		expect((await row()).moderationNote).toBe('after');
		await vi.waitFor(async () => expect(await audits()).toHaveLength(1));
		let drained = false; const idle = resources.instanceAdministration.idle().then(() => {
 drained = true; 
});
		await Promise.resolve(); expect(drained).toBe(false);
		release.resolve(); await idle;
		expect(logs.some(line => line.includes('instance-admin.failed') && line.includes('cache'))).toBe(true);
	} finally {
 release.resolve(); 
}
});

test('audit insert failure is reported after HTTP success without undoing the update', async () => {
	await resources.dataSource.query("CREATE FUNCTION instance_admin_audit_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit rejected'; END $$");
	await resources.dataSource.query('CREATE TRIGGER instance_admin_audit_reject BEFORE INSERT ON moderation_log FOR EACH ROW EXECUTE FUNCTION instance_admin_audit_reject()');
	try {
		expect((await post('update-instance', { host: 'remote.test', isSuspended: true, moderationNote: 'after' })).status).toBe(204);
		await resources.instanceAdministration.idle();
		expect(await row()).toMatchObject({ suspensionState: 'manuallySuspended', moderationNote: 'after' });
		expect(await audits()).toEqual([]);
		expect(logs.filter(line => line.includes('instance-admin.failed') && line.includes('audit'))).toHaveLength(2);
	} finally {
		await resources.dataSource.query('DROP TRIGGER instance_admin_audit_reject ON moderation_log');
		await resources.dataSource.query('DROP FUNCTION instance_admin_audit_reject()');
	}
});

test('forced refresh starts despite suspension/fresh timestamp/existing mutex and HTTP completes before metadata; resource close drains fetch', async () => {
	await resources.dataSource.getRepository(MiInstance).update(instanceId, { suspensionState: 'goneSuspended', infoUpdatedAt: new Date() });
	await resources.redis.set(lockKey, '1', 'EX', 30);
	const entered = deferred(); const release = deferred();
	peer.respond(async path => {
 if (path === '/') {
 entered.resolve(); await release.promise; 
} return metadataReply(path); 
});
	const response = await post('refresh-remote-instance-metadata', { host: 'REMOTE.TEST' }, 'instance-admin-scope-362');
	expect(response.status).toBe(204);
	await entered.promise;
	let drained = false; const idle = resources.instanceAdministration.close().then(() => {
 drained = true; 
});
	await Promise.resolve(); expect(drained).toBe(false);
	release.resolve(); await idle;
	expect(await row()).toMatchObject({ ...expectedMetadata, suspensionState: 'goneSuspended' });
	expect(await resources.redis.exists(lockKey)).toBe(0);
	expect(await audits()).toEqual([]);
});

test('forced metadata remote errors preserve HTTP success and save completion timestamp', async () => {
	peer.respond(async () => ({ status: 503 }));
	expect((await post('refresh-remote-instance-metadata', { host: 'remote.test' })).status).toBe(204);
	await resources.instanceAdministration.idle();
	expect((await row()).infoUpdatedAt).toBeInstanceOf(Date);
	expect((await row()).name).toBeNull();
	expect(logs.some(line => line.includes('instance-metadata.failed'))).toBe(true);
});

test('runtime shutdown waits for an accepted refresh before releasing Redis and database', async () => {
	const entered = deferred(); const release = deferred();
	peer.respond(async path => {
 if (path === '/') {
 entered.resolve(); await release.promise; 
} return metadataReply(path); 
});
	expect((await post('refresh-remote-instance-metadata', { host: 'remote.test' })).status).toBe(204);
	await entered.promise;
	let closed = false;
	const closing = resources.close().then(() => {
 closed = true; 
});
	try {
		// Give the other cleanup promises time to finish while metadata stays blocked.
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(closed).toBe(false);
		expect(resources.dataSource.isInitialized).toBe(true);
		expect(resources.redis.status).toBe('ready');
	} finally {
 release.resolve(); await closing; 
}
	expect(resources.dataSource.isInitialized).toBe(false);
	expect(resources.redis.status).toBe('end');
	expect(logs.some(line => line.includes('instance-metadata.failed'))).toBe(false);
});
