/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiMeta, MiModerationLog, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import type { DataSource } from 'typeorm';
import { createRoleApplication } from '../../src/composition/role.js';
import { createAccessRequest } from '../../src/modules/access/public.js';
import { createAttemptEvaluation } from '../../src/modules/role/public.js';
import type { RoleChanges } from '../../src/modules/role/public.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let observer: DataSource;
let seed: Awaited<ReturnType<typeof seedRoleHttp>>;
const atMs = Date.parse('2026-11-09T12:00:00Z');
const createdAtMs = 123456789;
let auditId: string;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const stored = () => source.getRepository(MiRole).findOneByOrFail({ id: seed.roleId });
const logs = () => source.getRepository(MiModerationLog).findBy({ type: 'updateRole' });
const accessRequest = (update = false) => createAccessRequest(update
	? { requireCredential: true, requireAdmin: true, kind: 'write:admin:roles' }
	: { requireCredential: true, requireModerator: true, kind: 'read:admin:roles' },
{ userId: seed.actors.root.id, native: true });
const application = (changes: RoleChanges = { invalidateLocal: () => {}, publish: async () => {} }) => createRoleApplication({
	dataSource: source,
	ids: { createdAtFromId: () => createdAtMs, newAuditId: () => auditId },
	clock: () => atMs,
	changes,
});

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	observer = await createDataSource(database.config.database).initialize();
	seed = await seedRoleHttp(source);
	auditId = seed.codec.newId(atMs);
	await source.getRepository(MiRoleAssignment).insert({ id: seed.codec.newId(atMs), roleId: seed.roleId, userId: seed.actors.root.id });
});
afterAll(async () => {
	await observer?.destroy();
	await source?.destroy();
	await database?.close();
});
beforeEach(async () => {
	vi.restoreAllMocks();
	await source.getRepository(MiMeta).update('singleton', { rootUserId: seed.actors.root.id });
	await source.getRepository(MiRole).update(seed.roleId, { name: 'target', updatedAt: new Date(atMs - 1000) });
	await source.getRepository(MiModerationLog).deleteAll();
});

test('constructs only show and update operations without opening a transaction', () => {
	const transaction = vi.spyOn(source, 'transaction');
	expect(Object.keys(application()).sort()).toEqual(['showRole', 'updateRole']);
	expect(transaction).not.toHaveBeenCalled();
});

test('shows a role without starting a transaction', async () => {
	const transaction = vi.spyOn(source, 'transaction');
	const access = accessRequest();
	const evaluation = createAttemptEvaluation(atMs);
	try {
		const result = await application().showRole(access, { roleId: seed.roleId }, evaluation);
		expect(result).toMatchObject({ role: { id: seed.roleId }, createdAtMs, assignedCount: 1 });
		expect(access.authorized).toBe(true);
		expect(transaction).not.toHaveBeenCalled();
	} finally {
		evaluation.close();
	}
});

test('updates and audits using injected clock and audit ID before notifying', async () => {
	const before = await stored();
	const transaction = vi.spyOn(source, 'transaction');
	const observations: unknown[] = [];
	const notifications: string[] = [];
	const app = application({
		invalidateLocal: () => {
			notifications.push('local');
		},
		publish: async () => {
			observations.push(await observer.getRepository(MiRole).findOneByOrFail({ id: seed.roleId }));
			observations.push(await observer.getRepository(MiModerationLog).findOneByOrFail({ id: auditId }));
			notifications.push('publish');
		},
	});
	const access = accessRequest(true);
	const evaluation = createAttemptEvaluation(atMs);
	try {
		await app.updateRole(access, { roleId: seed.roleId, name: 'composed' }, evaluation);
		expect(access.authorized).toBe(true);
		const after = await stored();
		expect(after).toMatchObject({ name: 'composed', updatedAt: new Date(atMs) });
		const [audit] = await logs();
		expect(audit).toMatchObject({ id: auditId, userId: seed.actors.root.id, info: { roleId: seed.roleId, before: json(before), after: json(after) } });
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(observations).toEqual([after, audit]);
		expect(notifications).toEqual(['local', 'publish']);
	} finally {
		evaluation.close();
	}
});

test('preserves success when publication rejects', async () => {
	const publish = vi.fn(async () => {
		throw new Error('publisher unavailable');
	});
	const evaluation = createAttemptEvaluation(atMs);
	try {
		await expect(application({ invalidateLocal: () => {}, publish }).updateRole(accessRequest(true), { roleId: seed.roleId, name: 'committed' }, evaluation)).resolves.toBeUndefined();
		expect(publish).toHaveBeenCalledOnce();
		expect((await stored()).name).toBe('committed');
		expect(await logs()).toHaveLength(1);
	} finally {
		evaluation.close();
	}
});

test('uses current transactional authorization for update', async () => {
	const publish = vi.fn(async () => {});
	const app = application({ invalidateLocal: () => {}, publish });
	await source.getRepository(MiMeta).update('singleton', { rootUserId: null });
	const before = await stored();
	const evaluation = createAttemptEvaluation(atMs);
	try {
		await expect(app.updateRole(accessRequest(true), { roleId: seed.roleId, name: 'rejected' }, evaluation)).rejects.toMatchObject({ reason: 'ADMINISTRATOR_REQUIRED' });
		expect(await stored()).toEqual(before);
		expect(await logs()).toEqual([]);
		expect(publish).not.toHaveBeenCalled();
	} finally {
		evaluation.close();
	}
});
