/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiMeta, MiModerationLog, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import type { DataSource } from 'typeorm';
import type { TransactionRunner } from '../../src/application/transaction.js';
import type { RoleUpdateScope } from '../../src/modules/role/update-contract.js';
import { createAttemptEvaluation, createUpdateRole, AdministratorRequired, ActorNotFound } from '../../src/modules/role/public.js';
import { createRoleUpdateTransactions } from '../../src/platform/database/role-update.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { deferred } from '../unit/role/fixtures.js';

const atMs = Date.parse('2026-10-17T12:00:00Z');
// ID codec自体は#120で設定に接続する。このテストは日時を保持するaidx形式を注入する。
const newId = (time: number) => time.toString(36).padStart(8, '0') + randomBytes(4).toString('hex');
const actorId = newId(atMs - 100000);
const roleId = newId(atMs - 10000);
const actor = { userId: actorId, credentialGrant: { readRole: true, updateRole: true } };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let transactions: TransactionRunner<RoleUpdateScope>;
let notifications: string[];

function updater(runner = transactions, clock = () => atMs) {
	return createUpdateRole({ transactions: runner, clock, changes: {
		invalidateLocal: event => {
			notifications.push(`local:${event.roleId}`);
		},
		publish: async event => {
			// commit確認後に別接続から両方の保存結果が見える。
			expect(await source.getRepository(MiModerationLog).count()).toBeGreaterThan(0);
			expect((await stored()).updatedAt.getTime()).toBeGreaterThanOrEqual(atMs);
			notifications.push(`publish:${event.roleId}`);
		},
	} });
}

const stored = () => source.getRepository(MiRole).findOneByOrFail({ id: roleId });
const logs = () => source.getRepository(MiModerationLog).find({ order: { id: 'ASC' } });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	transactions = createRoleUpdateTransactions(source, {
		createdAtFromId: id => Number.parseInt(id.slice(0, 8), 36),
		newAuditId: newId,
	});
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

beforeEach(async () => {
	notifications = [];
	await source.query('ALTER TABLE role DROP CONSTRAINT IF EXISTS role_update_test_failure');
	await source.query('ALTER TABLE moderation_log DROP CONSTRAINT IF EXISTS audit_update_test_failure');
	await source.getRepository(MiRoleAssignment).deleteAll();
	await source.getRepository(MiModerationLog).deleteAll();
	await source.getRepository(MiRole).deleteAll();
	await source.getRepository(MiMeta).deleteAll();
	await source.getRepository(MiUser).deleteAll();
	await source.getRepository(MiUser).insert({ id: actorId, username: 'role118', usernameLower: 'role118' });
	await source.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: actorId });
	await source.getRepository(MiRole).insert({
		id: roleId, name: 'before', description: 'keep', color: '#fff', iconUrl: 'icon',
		updatedAt: new Date(atMs - 1000), lastUsedAt: new Date(atMs - 2000),
	});
	await source.query('UPDATE role SET policies = $1 WHERE id = $2', [
		JSON.stringify({ original: { value: 100, useDefault: false, priority: 0 } }), roleId,
	]);
});

test('preserves omitted columns, clears nulls, replaces JSON, and audits full saved snapshots', async () => {
	const before = await stored();
	const policies = { unknown: { arbitrary: ['value'] } };
	const condFormula = { unknown: 'retained verbatim' };
	await updater().updateRole(actor, roleId, { name: 'after', color: null, iconUrl: null, policies, condFormula }, createAttemptEvaluation(atMs));
	const after = await stored();
	expect(after).toMatchObject({ name: 'after', description: 'keep', color: null, iconUrl: null, policies, condFormula });
	expect(after.policies).toEqual(policies);
	expect(after.condFormula).toEqual(condFormula);
	expect(after.lastUsedAt).toEqual(before.lastUsedAt);
	expect(after.updatedAt).toEqual(new Date(atMs));
	const [log] = await logs();
	expect(log).toMatchObject({ userId: actorId, type: 'updateRole', info: { roleId, before: json(before), after: json(after) } });
	expect(Number.parseInt(log.id.slice(0, 8), 36)).toBe(atMs);
	expect(notifications).toEqual([`local:${roleId}`, `publish:${roleId}`]);
});

test('updates the timestamp and audits even when the patch is empty', async () => {
	const before = await stored();
	await updater().updateRole(actor, roleId, {}, createAttemptEvaluation(atMs));
	const after = await stored();
	expect(after).toEqual({ ...before, updatedAt: new Date(atMs) });
	expect(await logs()).toHaveLength(1);
	expect(notifications).toHaveLength(2);
});

test('updates every permitted field but ignores extra keys and undefined values', async () => {
	const before = await stored();
	await updater().updateRole(actor, roleId, {
		name: undefined, description: 'changed', target: 'conditional', isPublic: true,
		isAdministrator: true, isModerator: true, isExplorable: true, asBadge: true,
		preserveAssignmentOnMoveAccount: true, canEditMembersByModerator: true, displayOrder: 9,
		...{ id: 'forged', updatedAt: new Date(0), lastUsedAt: new Date(0) },
	}, createAttemptEvaluation(atMs));
	expect(await stored()).toMatchObject({
		id: roleId, name: before.name, lastUsedAt: before.lastUsedAt, updatedAt: new Date(atMs),
		description: 'changed', target: 'conditional', isPublic: true, isAdministrator: true,
		isModerator: true, isExplorable: true, asBadge: true, preserveAssignmentOnMoveAccount: true,
		canEditMembersByModerator: true, displayOrder: 9,
	});
});

test.each(['role', 'audit'] as const)('rolls back both writes on actual %s storage failure', async (failure) => {
	const before = await stored();
	if (failure === 'role') {
		await source.query("ALTER TABLE role ADD CONSTRAINT role_update_test_failure CHECK (name <> 'rejected')");
	} else {
		await source.query("ALTER TABLE moderation_log ADD CONSTRAINT audit_update_test_failure CHECK (type <> 'updateRole')");
	}
	await expect(updater().updateRole(actor, roleId, { name: 'rejected' }, createAttemptEvaluation(atMs))).rejects.toThrow();
	expect(await stored()).toEqual(before);
	expect(await logs()).toEqual([]);
	expect(notifications).toEqual([]);
});

test('rejects credentials revoked in the DB even if the operation memo still grants administrator', async () => {
	await source.getRepository(MiMeta).update('singleton', { rootUserId: null });
	await source.getRepository(MiRole).update(roleId, { isAdministrator: true });
	await source.getRepository(MiRoleAssignment).insert({ id: newId(atMs), userId: actorId, roleId });
	const evaluation = createAttemptEvaluation(atMs);
	const session = evaluation.openSession({
		readRoles: async () => [await stored()],
		readAssignments: async () => [{ id: 'cached', userId: actorId, roleId, expiresAtMs: null }],
		readInstanceRoleFacts: async () => ({ rootUserId: null, basePolicies: {} }),
		readUserRoleFacts: async () => ({ userId: actorId, host: null, createdAtMs: 0, isSuspended: false,
			isLocked: false, isCat: false, isBot: false, isExplorable: true, followersCount: 0, followingCount: 0, notesCount: 0 }),
	}, 0);
	try {
		expect((await session.getPrivileges(actorId)).isAdministrator).toBe(true);
		await source.getRepository(MiRoleAssignment).deleteAll();
		await expect(updater().updateRole(actor, roleId, { isAdministrator: true }, evaluation)).rejects.toBeInstanceOf(AdministratorRequired);
		expect((await session.getPrivileges(actorId)).isAdministrator).toBe(true);
		expect(await logs()).toEqual([]);
	} finally {
		evaluation.close();
	}
});

test('evaluates conditional administrator facts from DB and permits revoking its own privilege', async () => {
	await source.getRepository(MiMeta).update('singleton', { rootUserId: null });
	await source.getRepository(MiRole).update(roleId, {
		target: 'conditional', isAdministrator: true,
		condFormula: { id: 'condition', type: 'createdMoreThan', sec: 50 },
	});
	await updater().updateRole(actor, roleId, { isAdministrator: false }, createAttemptEvaluation(atMs));
	expect((await stored()).isAdministrator).toBe(false);
	await expect(updater().updateRole(actor, roleId, { isAdministrator: true }, createAttemptEvaluation(atMs))).rejects.toBeInstanceOf(AdministratorRequired);
	expect(await logs()).toHaveLength(1);
});

test('rejects an actor that no longer exists', async () => {
	await expect(updater().updateRole({ ...actor, userId: 'missing' }, roleId, {}, createAttemptEvaluation(atMs))).rejects.toBeInstanceOf(ActorNotFound);
	expect(await logs()).toEqual([]);
});

test.each([false, true])('serializes concurrent patches and records actual before/after (same field: %s)', async (sameField) => {
	const locked = deferred<void>();
	const release = deferred<void>();
	let first = true;
	const coordinated: TransactionRunner<RoleUpdateScope> = {
		run: work => transactions.run(tx => {
			if (!first) {
				return work(tx);
			}
			first = false;
			return work({ ...tx, roles: { ...tx.roles, getForUpdate: async id => {
				const before = await tx.roles.getForUpdate(id);
				locked.resolve();
				await release.promise;
				return before;
			} } });
		}),
	};
	const a = updater(coordinated, () => atMs).updateRole(actor, roleId, { name: 'first' }, createAttemptEvaluation(atMs));
	await locked.promise;
	const b = updater(coordinated, () => atMs + 1).updateRole(actor, roleId, sameField ? { name: 'second' } : { description: 'second' }, createAttemptEvaluation(atMs));
	try {
		await vi.waitFor(async () => {
			const waiting = await source.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%role%'");
			expect(waiting.length).toBeGreaterThan(0);
		}, { timeout: 5000 });
	} finally {
		release.resolve();
		await Promise.allSettled([a, b]);
	}
	await Promise.all([a, b]);
	const entries = await logs();
	expect(entries).toHaveLength(2);
	expect(entries[0].info.before.name).toBe('before');
	expect(entries[0].info.after.name).toBe('first');
	expect(entries[1].info.before).toEqual(entries[0].info.after);
	expect(entries[1].info.after).toEqual(json(await stored()));
	expect(await stored()).toMatchObject({ name: sameField ? 'second' : 'first', description: sameField ? 'keep' : 'second' });
});

test('rejects transaction capabilities after their transaction has ended', async () => {
	let ended!: RoleUpdateScope;
	await transactions.run(async tx => {
		ended = tx;
	});
	await expect(ended.roles.getForUpdate(roleId)).rejects.toThrow('ended');
	await expect(ended.roles.savePatch(roleId, {}, atMs)).rejects.toThrow('ended');
	await expect(ended.authorizationFacts.read(actorId)).rejects.toThrow('ended');
});

test('preserves committed writes when the commit acknowledgement is reported as uncertain without retrying', async () => {
	const uncertain = new Error('commit acknowledgement lost');
	let attempts = 0;
	const acknowledgementLost: TransactionRunner<RoleUpdateScope> = {
		run: async work => {
			attempts++;
			await transactions.run(work);
			throw uncertain;
		},
	};
	await expect(updater(acknowledgementLost).updateRole(actor, roleId, { name: 'committed' }, createAttemptEvaluation(atMs))).rejects.toBe(uncertain);
	expect(attempts).toBe(1);
	expect((await stored()).name).toBe('committed');
	expect(await logs()).toHaveLength(1);
	expect(notifications).toEqual([]);
});

test('keeps role and audit committed when the post-commit publisher fails', async () => {
	const useCase = createUpdateRole({ transactions, clock: () => atMs, changes: {
		invalidateLocal: () => {},
		publish: async () => {
			throw new Error('redis unavailable');
		},
	} });
	await expect(useCase.updateRole(actor, roleId, { name: 'committed' }, createAttemptEvaluation(atMs))).resolves.toBeUndefined();
	expect((await stored()).name).toBe('committed');
	expect(await logs()).toHaveLength(1);
});

test('does not cancel an already authorized operation when another operation revokes its assignment', async () => {
	await source.getRepository(MiMeta).update('singleton', { rootUserId: null });
	await source.getRepository(MiRole).update(roleId, { isAdministrator: true });
	await source.getRepository(MiRoleAssignment).insert({ id: newId(atMs), userId: actorId, roleId });
	const revokeAfterRead: TransactionRunner<RoleUpdateScope> = {
		run: work => transactions.run(tx => work({ ...tx, authorizationFacts: { read: async id => {
			const facts = await tx.authorizationFacts.read(id);
			await source.getRepository(MiRoleAssignment).deleteAll();
			return facts;
		} } })),
	};
	await updater(revokeAfterRead).updateRole(actor, roleId, { name: 'authorized' }, createAttemptEvaluation(atMs));
	expect((await stored()).name).toBe('authorized');
	expect(await logs()).toHaveLength(1);
});

test('committed update invalidates real local/remote material caches and the operation memo', async () => {
	const { Redis } = await import('ioredis');
	const { openRoleMaterials } = await import('../../src/platform/role-materials.js');
	const { createRoleMaterialReader } = await import('../../src/platform/database/role-materials.js');
	const { user } = await import('../unit/role/fixtures.js');
	const publisher = new Redis({ ...database.config.redis, retryStrategy: () => null });
	await new Promise<void>(resolve => publisher.once('ready', resolve));
	const options = {
		source: createRoleMaterialReader(source.manager), publisher,
		subscriberConfig: { ...database.config.redis, prefix: `role119-${database.config.database}` },
		config: { rolesTtlMs: 30000, assignmentsTtlMs: 30000, assignmentsMaxEntries: 10 },
	};
	const a = await openRoleMaterials(options);
	const b = await openRoleMaterials(options);
	const evaluation = createAttemptEvaluation(atMs);
	try {
		await source.getRepository(MiRoleAssignment).insert({ id: newId(atMs), userId: actorId, roleId, expiresAt: null });
		const reader = {
			...a,
			readUserRoleFacts: async () => user({ userId: actorId }),
			readInstanceRoleFacts: async () => ({ rootUserId: null, basePolicies: {} }),
		};
		const session = evaluation.openSession(reader, 100);
		expect((await session.getPrivileges(actorId)).isAdministrator).toBe(false);
		await b.readRoles();
		await createUpdateRole({ transactions, clock: () => atMs, changes: a.changes })
			.updateRole(actor, roleId, { isAdministrator: true }, evaluation);
		expect((await session.getPrivileges(actorId)).isAdministrator).toBe(true);
		await vi.waitFor(async () => {
			expect((await b.readRoles())[0].isAdministrator).toBe(true);
		});

		publisher.disconnect();
		await vi.waitFor(() => expect(publisher.status).toBe('end'));
		await createUpdateRole({ transactions, clock: () => atMs, changes: a.changes })
			.updateRole(actor, roleId, { name: 'committed despite Redis loss' }, evaluation);
		expect((await stored()).name).toBe('committed despite Redis loss');
		expect(await source.getRepository(MiModerationLog).count()).toBe(2);
	} finally {
		evaluation.close();
		await a.close();
		await b.close();
		publisher.disconnect();
	}
});
