/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createUpdateRole } from '../../../src/modules/role/update-role.js';
import { RoleNotFound } from '../../../src/modules/role/errors.js';
import { createAttemptEvaluation } from '../../../src/modules/role/evaluation.js';
import type { AccessCredential } from '../../../src/modules/access/public.js';
import type { RoleDefinition, RoleUpdateScope } from '../../../src/modules/role/update-contract.js';
import { atMs, assignment, role, user } from './fixtures.js';
import { createAccessRequest } from '../../../src/modules/access/public.js';

const request = (credential: AccessCredential | null) => createAccessRequest({ requireAdmin: true, kind: 'write:admin:roles' }, credential);
const actor: AccessCredential = { userId: 'user', native: true };
const scoped = (...permissions: string[]): AccessCredential => ({ userId: 'user', native: false, permissions: new Set(permissions) });
const definition = (): RoleDefinition => ({
	...role(), name: 'before', description: 'keep', color: '#fff', iconUrl: 'icon',
	updatedAtMs: atMs - 1000, lastUsedAtMs: atMs - 2000,
	isPublic: false, isExplorable: false, asBadge: false,
	preserveAssignmentOnMoveAccount: false, canEditMembersByModerator: false, displayOrder: 0,
});

function setup() {
	let saved = definition();
	const facts = { user: user(), instance: { rootUserId: 'user' as string | null, basePolicies: {} }, roles: [saved], assignments: [assignment()] };
	const events: string[] = [];
	let failure: 'save' | 'audit' | 'commit' | undefined;
	const sentinel = new Error('storage or commit failure');
	const tx: RoleUpdateScope = {
		authorizationFacts: { read: async () => structuredClone(facts) },
		roles: {
			getForUpdate: async (id) => id === saved.id ? structuredClone(saved) : null,
			savePatch: async (_id, patch, time) => {
				if (failure === 'save') {
					throw sentinel;
				}
				saved = { ...saved, ...patch, updatedAtMs: time };
				events.push('save');
				return structuredClone(saved);
			},
		},
		auditLogs: { appendRoleUpdate: async (record) => {
			if (failure === 'audit') {
				throw sentinel;
			}
			expect(record.before.name).toBe('before');
			expect(record.after).toEqual(saved);
			expect(record.occurredAtMs).toBe(atMs);
			events.push('audit');
		} },
	};
	const changes = {
		invalidateLocal: () => {
			events.push('local');
		},
		publish: async () => {
			events.push('publish');
		},
	};
	const useCase = createUpdateRole({
		transactions: { run: async (work) => {
			const result = await work(tx);
			if (failure === 'commit') {
				throw sentinel;
			}
			events.push('commit');
			return result;
		} },
		changes,
		clock: () => atMs,
	});
	return { facts, events, changes, useCase, sentinel, tx, fail: (kind: typeof failure) => {
		failure = kind;
	} };
}

test('saves and audits before commit, then invalidates local materials and publishes', async () => {
	const s = setup();
	await s.useCase.updateRole(request(actor), { roleId: 'manual', name: 'after' }, createAttemptEvaluation(atMs));
	expect(s.events).toEqual(['save', 'audit', 'commit', 'local', 'publish']);
});

test.each([
	{ suspended: true, root: true, admin: true, scope: true, reason: 'YOUR_ACCOUNT_SUSPENDED' },
	{ suspended: false, root: false, admin: false, scope: false, reason: 'ADMINISTRATOR_REQUIRED' },
	{ suspended: false, root: true, admin: false, scope: false, reason: 'PERMISSION_DENIED' },
])('preserves rejection order for $reason', async ({ suspended, root, admin, scope, reason }) => {
	const s = setup();
	s.facts.user.isSuspended = suspended;
	s.facts.instance.rootUserId = root ? 'user' : null;
	s.facts.roles[0].isAdministrator = admin;
	const credential = scope ? scoped('read:admin:roles', 'write:admin:roles') : scoped('read:admin:roles');
	await expect(s.useCase.updateRole(request(credential), { roleId: 'missing' }, createAttemptEvaluation(atMs))).rejects.toMatchObject({ reason });
	expect(s.events).toEqual([]);
});

test('rejects a missing target after authorization', async () => {
	const s = setup();
	await expect(s.useCase.updateRole(request(actor), { roleId: 'missing' }, createAttemptEvaluation(atMs))).rejects.toBeInstanceOf(RoleNotFound);
	expect(s.events).toEqual([]);
});

test('cannot authorize itself using the requested promotion', async () => {
	const s = setup();
	s.facts.instance.rootUserId = null;
	await expect(s.useCase.updateRole(request(actor), { roleId: 'manual', isAdministrator: true }, createAttemptEvaluation(atMs))).rejects.toMatchObject({ reason: 'ADMINISTRATOR_REQUIRED' });
	expect(s.events).toEqual([]);
});

test('uses conditional administrator privileges from pre-update facts', async () => {
	const s = setup();
	s.facts.instance.rootUserId = null;
	s.facts.roles[0] = { ...definition(), target: 'conditional', condFormula: { type: 'isLocal' }, isAdministrator: true };
	s.facts.assignments = [];
	await s.useCase.updateRole(request(actor), { roleId: 'manual', isAdministrator: false }, createAttemptEvaluation(atMs));
	expect(s.events).toContain('commit');
});

test('rejects an administrator assignment expiring exactly at the evaluation time', async () => {
	const s = setup();
	s.facts.instance.rootUserId = null;
	s.facts.roles[0].isAdministrator = true;
	s.facts.assignments[0].expiresAtMs = atMs;
	await expect(s.useCase.updateRole(request(actor), { roleId: 'manual' }, createAttemptEvaluation(atMs))).rejects.toMatchObject({ reason: 'ADMINISTRATOR_REQUIRED' });
});

test.each(['save', 'audit', 'commit'] as const)('propagates %s failure without retry or notification', async (failure) => {
	const s = setup();
	s.fail(failure);
	await expect(s.useCase.updateRole(request(actor), { roleId: 'manual' }, createAttemptEvaluation(atMs))).rejects.toBe(s.sentinel);
	expect(s.events).not.toContain('local');
	expect(s.events).not.toContain('publish');
	expect(s.events.filter(event => event === 'save').length).toBe(failure === 'save' ? 0 : 1);
});

test.each(['invalidateLocal', 'publish'] as const)('keeps the committed update successful when %s fails', async (method) => {
	const s = setup();
	s.changes[method] = () => {
		throw new Error('notification failed');
	};
	await expect(s.useCase.updateRole(request(actor), { roleId: 'manual' }, createAttemptEvaluation(atMs))).resolves.toBeUndefined();
	expect(s.events).toContain('commit');
});

test('invalidates operation memos after commit and preserves their reference time', async () => {
	const s = setup();
	const evaluation = createAttemptEvaluation(atMs);
	let reads = 0;
	const session = evaluation.openSession({
		readRoles: async () => {
			reads++;
			return s.facts.roles;
		},
		readAssignments: async () => s.facts.assignments,
		readUserRoleFacts: async () => s.facts.user,
		readInstanceRoleFacts: async () => s.facts.instance,
	}, 0);
	s.facts.instance.rootUserId = null;
	s.facts.roles[0].isAdministrator = true;
	expect((await session.getPrivileges('user')).isAdministrator).toBe(true);
	await s.useCase.updateRole(request(actor), { roleId: 'manual' }, evaluation);
	s.facts.roles[0].isAdministrator = false;
	expect((await session.getPrivileges('user')).isAdministrator).toBe(false);
	expect(reads).toBe(2);
	expect(evaluation.atMs).toBe(atMs);
	evaluation.close();
});

test('rejects malformed input after authorization but before looking up the target', async () => {
	const s = setup();
	await expect(s.useCase.updateRole(request(actor), { roleId: '!', name: null }, createAttemptEvaluation(atMs)))
		.rejects.toMatchObject({ param: '#/properties/roleId/format' });
	expect(s.events).toEqual([]);
	s.facts.user.isSuspended = true;
	await expect(s.useCase.updateRole(request(actor), {}, createAttemptEvaluation(atMs))).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
});

test('snapshots supported input before asynchronous authorization and lock waits', async () => {
 const s = setup();
 const input = { roleId: 'manual', name: 'after', policies: { limit: { value: 1 } } };
 const pending = s.useCase.updateRole(request(actor), input, createAttemptEvaluation(atMs));
 input.name = 'mutated';
 input.policies.limit.value = 2;
 await pending;
 expect(await s.tx.roles.getForUpdate('manual')).toMatchObject({ name: 'after', policies: { limit: { value: 1 } } });
});
