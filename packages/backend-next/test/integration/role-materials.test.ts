/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterEach, expect, test, vi } from 'vitest';
import { openRoleMaterials } from '../../src/platform/role-materials.js';
import { testConfig } from '../helpers/database.js';
import { assignment, deferred, role, user } from '../unit/role/fixtures.js';
import { createAttemptEvaluation } from '../../src/modules/role/public.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

async function setup(prefix = randomUUID()) {
	const config = testConfig();
	const publisher = new Redis({ ...config.redis, enableOfflineQueue: false, retryStrategy: () => null });
	await new Promise<void>(resolve => publisher.once('ready', resolve));
	cleanups.push(async () => {
		publisher.disconnect();
	});
	let now = 0;
	let roles = [role({ policies: { canInvite: { value: false, priority: 1 } } })];
	const source = { readRoles: vi.fn(async () => roles), readAssignments: vi.fn(async (userId: string) => [assignment({ userId, expiresAtMs: 50 })]) };
	const connectionName = `role119-${randomUUID()}`;
	const materials = await openRoleMaterials({
		source, publisher,
		subscriberConfig: { ...config.redis, prefix, connectionName },
		config: { rolesTtlMs: 100, assignmentsTtlMs: 100, assignmentsMaxEntries: 2 },
		clock: () => now,
	});
	cleanups.push(materials.close);
	return {
		materials, source, publisher, prefix, connectionName,
		time: (value: number) => {
			now = value;
		},
		change: () => {
			roles = [role({ id: 'changed', isAdministrator: true })];
		},
	};
}

const event = { kind: 'role-definitions-changed' as const, roleId: 'manual' };

test('notifies other processes via real Redis, invalidates locally and never trusts payload values', async () => {
	const a = await setup();
	const b = await setup(a.prefix);
	await a.materials.readRoles();
	await b.materials.readRoles();
	a.change();
	b.change();
	a.materials.changes.invalidateLocal(event);
	await a.materials.changes.publish(event);
	await vi.waitFor(async () => {
		expect((await b.materials.readRoles())[0].id).toBe('changed');
	});
	expect((await a.materials.readRoles())[0].id).toBe('changed');
	expect(b.source.readRoles).toHaveBeenCalledTimes(2);
});

test('missed notification recovers at start-based TTL, independently of assignment expiry', async () => {
	const f = await setup();
	const reader = { ...f.materials, readUserRoleFacts: async () => user(), readInstanceRoleFacts: async () => ({ rootUserId: null, basePolicies: { canInvite: true } }) };
	const first = createAttemptEvaluation(49);
	expect((await first.openSession(reader, 100).getEffectivePolicies('user')).canInvite).toBe(false);
	first.close();
	f.change();
	f.time(99);
	expect((await f.materials.readRoles())[0].id).toBe('manual');
	const next = createAttemptEvaluation(50);
	expect((await next.openSession(reader, 100).getEffectivePolicies('user')).canInvite).toBe(true);
	next.close();
	expect(f.source.readAssignments).toHaveBeenCalledTimes(1);
	f.time(100);
	expect((await f.materials.readRoles())[0].id).toBe('changed');
});

test('notification during DB read prevents stale repopulation', async () => {
	const f = await setup();
	const old = deferred<ReturnType<typeof role>[]>();
	f.source.readRoles.mockReturnValueOnce(old.promise);
	const pending = f.materials.readRoles();
	await vi.waitFor(() => expect(f.source.readRoles).toHaveBeenCalledTimes(1));
	f.change();
	await f.materials.changes.publish(event);
	let observed: string | undefined;
	await vi.waitFor(() => {
		void f.materials.readRoles().then(values => {
			observed = values[0].id;
		});
		expect(observed).toBe('changed');
	});
	old.resolve([role({ id: 'old' })]);
	await pending;
	expect((await f.materials.readRoles())[0].id).toBe('changed');
});

test('subscriber reconnect clears both material caches and reacquires subscription', async () => {
	const f = await setup();
	await f.materials.readRoles();
	await f.materials.readAssignments('user');
	f.change();
	const clients = String(await f.publisher.client('LIST'));
	const line = clients.split('\n').find(value => value.includes(`name=${f.connectionName} `));
	expect(line).toBeDefined();
	const id = line!.match(/^id=(\d+)/)![1];
	await f.publisher.client('KILL', 'ID', id);
	await vi.waitFor(async () => {
		expect((await f.materials.readRoles())[0].id).toBe('changed');
	});
	await f.materials.readAssignments('user');
	expect(f.source.readAssignments).toHaveBeenCalledTimes(2);
});

test('separate prefixes do not invalidate unrelated instances', async () => {
	const a = await setup();
	const b = await setup();
	await b.materials.readRoles();
	b.change();
	await a.materials.changes.publish(event);
	expect((await b.materials.readRoles())[0].id).toBe('manual');
});

test('required Redis failure and close reject reads without falling back to DB', async () => {
	const f = await setup();
	await f.materials.readRoles();
	f.publisher.disconnect();
	await vi.waitFor(() => expect(f.publisher.status).toBe('end'));
	await expect(f.materials.readRoles()).rejects.toThrow();
	await expect(f.materials.readAssignments('user')).rejects.toThrow();
	await expect(f.materials.changes.publish(event)).rejects.toThrow();
	expect(f.source.readRoles).toHaveBeenCalledTimes(1);
	expect(f.source.readAssignments).not.toHaveBeenCalled();
	await f.materials.close();
	await f.materials.close();
	await expect(f.materials.readRoles()).rejects.toThrow();
});

test('rejects reads before reconnect subscription acknowledgement and ignores late ACK after close', async () => {
	const f = await setup();
	await f.materials.readRoles();
	const acknowledged = deferred<void>();
	const release = deferred<void>();
	const original = Redis.prototype.subscribe;
	// 実Redisの応答は受信するが、アダプタへ完了を返す時点を制御する。
	const subscribe = vi.spyOn(Redis.prototype, 'subscribe').mockImplementation(async function (this: Redis, ...args: Parameters<Redis['subscribe']>) {
		const result = await original.apply(this, args);
		acknowledged.resolve();
		await release.promise;
		return result;
	});
	try {
		const clients = String(await f.publisher.client('LIST'));
		const line = clients.split('\n').find(value => value.includes(`name=${f.connectionName} `))!;
		await f.publisher.client('KILL', 'ID', line.match(/^id=(\d+)/)![1]);
		await acknowledged.promise;
		await expect(f.materials.readRoles()).rejects.toThrow('unavailable');
		await expect(f.materials.readAssignments('user')).rejects.toThrow('unavailable');
		expect(f.source.readRoles).toHaveBeenCalledTimes(1);
		await f.materials.close();
		release.resolve();
		await Promise.resolve();
		await expect(f.materials.readRoles()).rejects.toThrow('unavailable');
	} finally {
		release.resolve();
		subscribe.mockRestore();
	}
});
