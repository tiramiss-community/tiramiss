/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createAttemptEvaluation, createRequestEvaluation, EvaluationClosed, EvaluationInvalidated } from '../../../src/modules/role/public.js';
import type { EvaluationRole, InstanceRoleFacts, RoleAssignment } from '../../../src/modules/role/model.js';
import type { RoleFactsReader } from '../../../src/modules/role/evaluation.js';
import { assignment, atMs, deferred, policy, role, user } from './fixtures.js';

class MemoryReader implements RoleFactsReader {
	roles: EvaluationRole[] = [role({ policies: { driveCapacityMb: policy(200) }, isAdministrator: true })];
	assignments: RoleAssignment[] = [assignment()];
	users = new Map([['user', user()], ['other', user({ userId: 'other' })]]);
	instance: InstanceRoleFacts = { rootUserId: 'root', basePolicies: { driveCapacityMb: 55 } };
	readRoles = vi.fn(async () => this.roles);
	readAssignments = vi.fn(async (userId: string) => this.assignments.filter(value => value.userId === userId));
	readUserRoleFacts = vi.fn(async (userId: string) => {
		const facts = this.users.get(userId);
		if (!facts) {
			throw new Error(`Missing user: ${userId}`);
		}
		return facts;
	});
	readInstanceRoleFacts = vi.fn(async () => this.instance);
}

function setup() {
	const reader = new MemoryReader();
	const evaluation = createRequestEvaluation(() => atMs);
	const session = evaluation.openSession(reader, 20 * 1024 * 1024);
	return { reader, evaluation, session };
}

test('request time is lazy and remains fixed across expiry and explicit invalidation', async () => {
	let now = atMs;
	const clock = vi.fn(() => now);
	const reader = new MemoryReader();
	reader.assignments[0].expiresAtMs = atMs + 1;
	const evaluation = createRequestEvaluation(clock);
	const session = evaluation.openSession(reader, 20 * 1024 * 1024);
	expect(clock).not.toHaveBeenCalled();
	expect((await session.getEffectivePolicies('user')).driveCapacityMb).toBe(200);
	now += 2;
	evaluation.invalidate({ kind: 'assignments', userId: 'user' });
	expect((await session.getEffectivePolicies('user')).driveCapacityMb).toBe(200);
	expect(clock).toHaveBeenCalledTimes(1);
	const next = createRequestEvaluation(clock).openSession(reader, 20 * 1024 * 1024);
	expect((await next.getEffectivePolicies('user')).driveCapacityMb).toBe(55);
});

test('job attempts use their start time and retries create fresh boundaries', async () => {
	const reader = new MemoryReader();
	reader.assignments[0].expiresAtMs = atMs + 1;
	const first = createAttemptEvaluation(atMs).openSession(reader, 20 * 1024 * 1024);
	const retry = createAttemptEvaluation(atMs + 1).openSession(reader, 20 * 1024 * 1024);
	expect((await first.getPrivileges('user')).isAdministrator).toBe(true);
	expect((await retry.getPrivileges('user')).isAdministrator).toBe(false);
});

test('parallel policy and privilege reads share user material and computations', async () => {
	const { reader, session } = setup();
	const [first, second, privileges] = await Promise.all([
		session.getEffectivePolicies('user'), session.getEffectivePolicies('user'), session.getPrivileges('user'),
	]);
	expect(first.driveCapacityMb).toBe(200);
	expect(second.driveCapacityMb).toBe(200);
	expect(privileges).toEqual({ isAdministrator: true, isModerator: true });
	expect(reader.readRoles).toHaveBeenCalledTimes(1);
	expect(reader.readAssignments).toHaveBeenCalledExactlyOnceWith('user');
	expect(reader.readUserRoleFacts).toHaveBeenCalledExactlyOnceWith('user');
	expect(reader.readInstanceRoleFacts).toHaveBeenCalledTimes(1);
});

test('anonymous has no user reads and root qualifications need no policy aggregation', async () => {
	const { reader, session } = setup();
	expect((await session.getEffectivePolicies(null)).driveCapacityMb).toBe(55);
	expect(await session.getPrivileges(null)).toEqual({ isAdministrator: false, isModerator: false });
	expect(await session.getPrivileges('root')).toEqual({ isAdministrator: true, isModerator: true });
	expect(reader.readRoles).not.toHaveBeenCalled();
	expect(reader.readAssignments).not.toHaveBeenCalled();
	expect(reader.readUserRoleFacts).not.toHaveBeenCalled();
	reader.roles[0].policies = null;
	expect(await session.getPrivileges('user')).toEqual({ isAdministrator: true, isModerator: true });
	await expect(session.getEffectivePolicies('user')).rejects.toThrow(TypeError);
});

test('users, operations and reference conditions do not share results', async () => {
	const { reader, evaluation, session: normal } = setup();
	expect((await normal.getEffectivePolicies('user')).driveCapacityMb).toBe(200);
	expect((await normal.getEffectivePolicies('other')).driveCapacityMb).toBe(55);
	const db = new MemoryReader();
	db.roles[0].policies = { driveCapacityMb: policy(300) };
	const tx = evaluation.openSession(db, 20 * 1024 * 1024);
	expect((await tx.getEffectivePolicies('user')).driveCapacityMb).toBe(300);
	tx.close();
	await expect(tx.getEffectivePolicies('user')).rejects.toBeInstanceOf(EvaluationClosed);
	expect((await normal.getEffectivePolicies('user')).driveCapacityMb).toBe(200);
	db.roles[0].policies = { driveCapacityMb: policy(400) };
	expect((await evaluation.openSession(db, 20 * 1024 * 1024).getEffectivePolicies('user')).driveCapacityMb).toBe(400);
	reader.roles[0].policies = { driveCapacityMb: policy(500) };
	expect((await createRequestEvaluation(() => atMs).openSession(reader, 20 * 1024 * 1024).getEffectivePolicies('user')).driveCapacityMb).toBe(500);
});

test.each(['roles', 'assignments', 'user', 'instance'] as const)('%s changes invalidate dependent policy and privilege results', async (kind) => {
	const { reader, evaluation, session } = setup();
	reader.roles[0].target = 'conditional';
	reader.roles[0].condFormula = { type: 'isCat' };
	reader.roles[0].policies = { driveCapacityMb: policy(200, 0, true) };
	await Promise.all([session.getEffectivePolicies('user'), session.getPrivileges('user'), session.getEffectivePolicies('other')]);
	if (kind === 'roles') {
		reader.roles = [];
		evaluation.invalidate({ kind });
	} else if (kind === 'assignments') {
		reader.assignments = [];
		evaluation.invalidate({ kind, userId: 'user' });
	} else if (kind === 'user') {
		reader.assignments = [];
		// 先に割り当てだけを更新し、後の属性変更が未適用ユーザーへ届くことも確認する。
		evaluation.invalidate({ kind: 'assignments', userId: 'user' });
		await session.getPrivileges('user');
		reader.users.set('user', user({ isCat: true }));
		evaluation.invalidate({ kind, userId: 'user' });
	} else {
		reader.instance = { rootUserId: 'other', basePolicies: { driveCapacityMb: 77 } };
		evaluation.invalidate({ kind });
	}
	const policies = await session.getEffectivePolicies('user');
	const privileges = await session.getPrivileges('user');
	expect(policies.driveCapacityMb).toBe(kind === 'instance' ? 77 : 55);
	expect(privileges.isAdministrator).toBe(kind === 'user' || kind === 'instance');
	if (kind === 'instance') {
		expect((await session.getPrivileges('other')).isAdministrator).toBe(true);
		expect((await session.getEffectivePolicies(null)).driveCapacityMb).toBe(77);
	}
	if (kind === 'assignments' || kind === 'user') {
		expect((await session.getEffectivePolicies('other')).driveCapacityMb).toBe(55);
		expect(reader.readUserRoleFacts.mock.calls.filter(([id]) => id === 'other')).toHaveLength(1);
	}
});

test('role changes reevaluate previously inapplicable users in every reference session', async () => {
	const { reader, evaluation, session } = setup();
	const second = evaluation.openSession(reader, 20 * 1024 * 1024);
	await Promise.all([session.getPrivileges('other'), second.getPrivileges('other')]);
	reader.roles[0].target = 'conditional';
	reader.roles[0].condFormula = { type: 'isLocal' };
	evaluation.invalidate({ kind: 'roles' });
	expect((await session.getPrivileges('other')).isAdministrator).toBe(true);
	expect((await second.getPrivileges('other')).isAdministrator).toBe(true);
});

test('user material read errors propagate and permit a later explicit read', async () => {
	const { reader, session } = setup();
	await expect(session.getEffectivePolicies('missing')).rejects.toThrow('Missing user: missing');
	reader.users.set('missing', user({ userId: 'missing' }));
	expect((await session.getEffectivePolicies('missing')).driveCapacityMb).toBe(55);
});

test('public results and reader-owned JSON cannot mutate memoized evaluations', async () => {
	const { reader, session } = setup();
	const first = await session.getEffectivePolicies('user');
	first.uploadableFileTypes.push('caller');
	first.driveCapacityMb = 999;
	reader.roles[0].policies = { driveCapacityMb: policy(999) };
	const privileges = await session.getPrivileges('user');
	privileges.isAdministrator = false;
	expect((await session.getEffectivePolicies('user')).driveCapacityMb).toBe(200);
	expect((await session.getEffectivePolicies('user')).uploadableFileTypes).not.toContain('caller');
	expect((await session.getPrivileges('user')).isAdministrator).toBe(true);
});

test.each(['roles', 'assignments', 'user', 'instance'] as const)('invalidation during a pending %s read rejects the entire evaluation', async (kind) => {
	const { reader, evaluation, session } = setup();
	const started = deferred<void>();
	const release = deferred<void>();
	const wait = async <T>(value: T) => {
		started.resolve();
		await release.promise;
		return value;
	};
	if (kind === 'roles') {
		reader.readRoles.mockImplementationOnce(() => wait(reader.roles));
	} else if (kind === 'assignments') {
		reader.readAssignments.mockImplementationOnce(() => wait(reader.assignments));
	} else if (kind === 'user') {
		reader.readUserRoleFacts.mockImplementationOnce(() => wait(user()));
	} else {
		reader.readInstanceRoleFacts.mockImplementationOnce(() => wait(reader.instance));
	}
	const pending = session.getEffectivePolicies('user');
	const rejected = expect(pending).rejects.toBeInstanceOf(EvaluationInvalidated);
	await started.promise;
	if (kind === 'assignments' || kind === 'user') {
		evaluation.invalidate({ kind, userId: 'user' });
	} else {
		evaluation.invalidate({ kind });
	}
	release.resolve();
	await rejected;
	expect((await session.getEffectivePolicies('user')).driveCapacityMb).toBe(200);
});

test('closing a session during a read blocks late uncommitted values and preserves other sessions', async () => {
	const { reader, evaluation, session: normal } = setup();
	const pending = deferred<InstanceRoleFacts>();
	const started = deferred<void>();
	const db = new MemoryReader();
	db.readInstanceRoleFacts.mockImplementationOnce(() => {
		started.resolve();
		return pending.promise;
	});
	const tx = evaluation.openSession(db, 20 * 1024 * 1024);
	const read = tx.getEffectivePolicies(null);
	const rejected = expect(read).rejects.toBeInstanceOf(EvaluationClosed);
	await started.promise;
	tx.close();
	pending.resolve({ rootUserId: null, basePolicies: { driveCapacityMb: 999 } });
	await rejected;
	expect((await normal.getEffectivePolicies(null)).driveCapacityMb).toBe(55);
	expect(reader.readInstanceRoleFacts).toHaveBeenCalledTimes(1);
	evaluation.close();
	evaluation.close();
	await expect(normal.getPrivileges(null)).rejects.toBeInstanceOf(EvaluationClosed);
	expect(() => evaluation.openSession(db, 100)).toThrow(EvaluationClosed);
	expect(() => evaluation.invalidate({ kind: 'roles' })).toThrow(EvaluationClosed);
});

test('direct DB authorization shares the lazy reference time with memoized evaluation', async () => {
	let now = atMs;
	const reader = new MemoryReader();
	reader.assignments[0].expiresAtMs = atMs + 1;
	const evaluation = createRequestEvaluation(() => now);
	expect(evaluation.atMs).toBe(atMs);
	now += 2;
	const session = evaluation.openSession(reader, 0);
	expect((await session.getPrivileges('user')).isAdministrator).toBe(true);
	evaluation.invalidate({ kind: 'roles' });
	expect(evaluation.atMs).toBe(atMs);
	evaluation.close();
	expect(() => evaluation.atMs).toThrow(EvaluationClosed);
});
