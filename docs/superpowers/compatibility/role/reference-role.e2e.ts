/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// This probe is copied into the pinned reference checkout; see README.md.
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';
import { api, signup, createAppToken, initTestDb } from '../utils.js';
import { MiRole } from '@/models/Role.js';
import { MiRoleAssignment } from '@/models/RoleAssignment.js';
import { MiUser } from '@/models/User.js';
import { MiModerationLog } from '@/models/ModerationLog.js';
import { MiApp } from '@/models/App.js';
import { MiAccessToken } from '@/models/AccessToken.js';
import { genAidx } from '@/misc/id/aidx.js';
import { RoleService, DEFAULT_POLICIES } from '@/core/RoleService.js';
import { MiMeta } from '@/models/Meta.js';
import { parseAidx } from '@/misc/id/aidx.js';
import { loadConfig } from '@/config.js';
import { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';

const cases = JSON.parse(readFileSync(new URL('./role-http-cases.json', import.meta.url), 'utf8'));
const config = loadConfig();
if (process.env.NODE_ENV !== 'test' || config.db.host !== '127.0.0.1' || config.db.port !== 55116 || config.db.db !== 'backend_next_test' || config.redis.port !== 56116 || config.port !== 61116) {
	throw new Error('The reference probe requires the dedicated role-116 test configuration.');
}
const actors: Record<string, { id?: string; token: string } | undefined> = {};
let db: DataSource;
let roleId: string;

describe('pinned upstream Role HTTP contract', () => {
	beforeAll(async () => {
		for (const actor of ['root', 'ordinary', 'moderator', 'administrator', 'suspended', 'expired']) {
			actors[actor] = await signup({ username: `probe_${actor}` });
			expect(actors[actor]?.token, actor).toBeTruthy();
		}

		db = await initTestDb(true);
		roleId = genAidx(Date.now());
		await db.getRepository(MiRole).insert({ id: roleId, name: 'target', description: 'keep', updatedAt: new Date(), lastUsedAt: new Date() });
		for (const actor of ['moderator', 'administrator', 'suspended', 'expired']) {
			const id = genAidx(Date.now());
			await db.getRepository(MiRole).insert({
				id, name: actor, description: '', updatedAt: new Date(), lastUsedAt: new Date(),
				isModerator: actor === 'moderator', isAdministrator: actor !== 'moderator',
			});
			await db.getRepository(MiRoleAssignment).insert({
				id: genAidx(Date.now()), roleId: id, userId: actors[actor]!.id,
				expiresAt: actor === 'expired' ? new Date(0) : null,
			});
		}
		await db.getRepository(MiUser).update(actors.suspended!.id!, { isSuspended: true });
		actors.invalid = { token: 'invalid-token-116' };
		actors.readScope = { token: await createAppToken(actors.root!, ['read:admin:roles']) };
		actors.writeScope = { token: await createAppToken(actors.root!, ['write:admin:roles']) };
		actors.ordinaryNoScope = { token: await createAppToken(actors.ordinary!, []) };
		const appId = genAidx(Date.now());
		await db.getRepository(MiApp).insert({ id: appId, name: 'probe', description: '', secret: 'probe-test-only', permission: ['read:admin:roles'] });
		await db.getRepository(MiAccessToken).insert({ id: genAidx(Date.now()), userId: actors.root!.id, appId, token: 'app-token-probe-116', hash: 'app-hash-probe-116', permission: ['write:admin:roles'] });
		actors.appRead = { token: 'APP-HASH-PROBE-116' };
		const publisher = new Redis(config.redis);
		try {
			for (const row of await db.getRepository(MiRole).find()) {
				await publisher.publish(config.host, JSON.stringify({ channel: 'internal', message: { type: 'roleCreated', body: row } }));
			}
			for (const row of await db.getRepository(MiRoleAssignment).find()) {
				await publisher.publish(config.host, JSON.stringify({ channel: 'internal', message: { type: 'userRoleAssigned', body: row } }));
			}
		} finally {
			await publisher.quit();
		}
		await vi.waitFor(async () => {
			expect((await api('admin/roles/show', { roleId }, actors.administrator)).status).toBe(200);
		});
	}, 120000);

	afterAll(async () => {
		await db?.destroy();
	});

	test.each(cases)('$name', async (entry) => {
		const before = await db.getRepository(MiRole).findOneByOrFail({ id: roleId });
		const params = { roleId, ...entry.params };
		const response = await api(`admin/roles/${entry.endpoint}` as never, params, actors[entry.actor]);
		expect(response.status).toBe(entry.status);
		if (entry.code) {
			expect(response.body).toMatchObject({ error: { code: entry.code, id: entry.id, message: entry.message, kind: entry.kind, ...(entry.info ? { info: entry.info } : {}) } });
			if (entry.wwwAuthenticate) {
				expect(response.headers.get('www-authenticate')).toBe(entry.wwwAuthenticate);
			}
			const after = await db.getRepository(MiRole).findOneByOrFail({ id: roleId });
			expect(after).toEqual(before);
		} else if (entry.endpoint === 'show') {
			expect(response.body).toMatchObject({ id: roleId, name: 'target', description: 'keep', usersCount: 0 });
			for (const [key, value] of Object.entries(DEFAULT_POLICIES)) {
				expect(response.body.policies[key]).toEqual({ useDefault: true, priority: 0, value });
			}
		} else {
			expect(response.body).toBeNull();
			const after = await db.getRepository(MiRole).findOneByOrFail({ id: roleId });
			expect(after.description).toBe('keep');
		}
	});

	test('partial policy replacement, audit snapshots, nullable fields and no-op timestamp', async () => {
		expect((await api('admin/roles/update', {
			roleId, policies: { canInvite: { useDefault: false, priority: 1, value: true }, pinLimit: { useDefault: false, priority: 1, value: 7 } },
		}, actors.root)).status).toBe(204);
		const before = await db.getRepository(MiRole).findOneByOrFail({ id: roleId });
		const policies = { driveCapacityMb: { useDefault: false, priority: 2, value: 250 } };
		expect((await api('admin/roles/update', { roleId, name: 'changed', policies, color: null, iconUrl: null }, actors.root)).status).toBe(204);
		const after = await db.getRepository(MiRole).findOneByOrFail({ id: roleId });
		expect(after).toMatchObject({ name: 'changed', description: 'keep', policies, color: null, iconUrl: null });
		expect(after.policies).toEqual(policies);
		await expect.poll(async () => db.getRepository(MiModerationLog).findBy({ type: 'updateRole' })).toSatisfy(
			(logs: MiModerationLog[]) => logs.some(log => log.info.roleId === roleId && log.info.after.name === 'changed'),
		);
		const logs = await db.getRepository(MiModerationLog).findBy({ type: 'updateRole' });
		const log = logs.find(item => item.info.roleId === roleId && item.info.after.name === 'changed')!;
		expect(log.userId).toBe(actors.root!.id);
		expect(log.info.before).toEqual(JSON.parse(JSON.stringify(before)));
		expect(log.info.after).toEqual(JSON.parse(JSON.stringify(after)));
		await vi.waitFor(() => {
			expect(Date.now()).toBeGreaterThan(after.updatedAt.getTime());
		});
		expect((await api('admin/roles/update', { roleId }, actors.root)).status).toBe(204);
		const noop = await db.getRepository(MiRole).findOneByOrFail({ id: roleId });
		expect(noop.updatedAt.getTime()).toBeGreaterThan(after.updatedAt.getTime());
	});

	test('Bearer token takes precedence over body token', async () => {
		const response = await fetch('http://127.0.0.1:61116/api/admin/roles/show', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actors.root!.token}` },
			body: JSON.stringify({ roleId, i: actors.invalid!.token }),
		});
		expect(response.status).toBe(200);
	});

	test('GET is rejected', async () => {
		const url = 'http://127.0.0.1:61116/api/admin/roles/show';
		const get = await fetch(url);
		expect(get.status).toBe(405);
		expect(await get.text()).toBe('');
	});

	test('upstream leaves non-string credentials pending; new backend intentionally returns 400', async () => {
		await expect(fetch('http://127.0.0.1:61116/api/admin/roles/show', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ roleId, i: 123 }), signal: AbortSignal.timeout(500),
		})).rejects.toMatchObject({ name: 'TimeoutError' });
	});

	test('usersCount counts active assignments rather than matching conditional users', async () => {
		await db.getRepository(MiRoleAssignment).insert([
			{ id: genAidx(Date.now()), roleId, userId: actors.ordinary!.id, expiresAt: null },
			{ id: genAidx(Date.now()), roleId, userId: actors.expired!.id, expiresAt: new Date(0) },
		]);
		expect((await api('admin/roles/update', { roleId, target: 'conditional', condFormula: { type: 'isLocal' } }, actors.root)).status).toBe(204);
		const show = await api('admin/roles/show', { roleId }, actors.root);
		expect(show.status).toBe(200);
		expect(show.body.usersCount).toBe(1);
	});
	test('HTTP policy updates match the shared flow with real DB materials and upstream evaluation', async () => {
		const flow = JSON.parse(readFileSync(new URL('./role-policy-flow-cases.json', import.meta.url), 'utf8'));
		await db.query('UPDATE meta SET policies = $1', [JSON.stringify({ canInvite: false, driveCapacityMb: 55 })]);
		await db.getRepository(MiRole).update(roleId, { target: 'manual', name: 'target', description: 'keep' });
		await db.query('UPDATE role SET policies = $1 WHERE id = $2', [JSON.stringify({}), roleId]);
		await db.getRepository(MiRoleAssignment).delete({ roleId });
		await db.getRepository(MiRoleAssignment).insert({ id: genAidx(Date.now()), roleId, userId: actors.ordinary!.id!, expiresAt: null });
		const context = {
			rolesCache: { fetch: () => db.getRepository(MiRole).find() },
			roleAssignmentByUserIdCache: { fetch: (userId: string) => db.getRepository(MiRoleAssignment).findBy({ userId }) },
			cacheService: { findUserById: (id: string) => db.getRepository(MiUser).findOneByOrFail({ id }) },
			userEntityService: { isLocalUser: (user: MiUser) => user.host === null, isRemoteUser: (user: MiUser) => user.host !== null },
			idService: { parse: parseAidx },
			config: { maxFileSize: 20 * 1024 * 1024 },
			meta: await db.getRepository(MiMeta).findOneByOrFail({}),
			evalCond: RoleService.prototype['evalCond'],
			getUserRoles: RoleService.prototype.getUserRoles,
			getUserAssigns: RoleService.prototype.getUserAssigns,
		};
		expect(await RoleService.prototype.getUserPolicies.call(context as never, actors.ordinary!.id!)).toMatchObject({ canInvite: false, driveCapacityMb: 55 });
		for (const entry of flow) {
			expect((await api('admin/roles/update', { roleId, ...entry.patch }, actors.root)).status, entry.name).toBe(204);
			expect(await RoleService.prototype.getUserPolicies.call(context as never, actors.ordinary!.id!)).toMatchObject(entry.expected);
		}
	});
});
