/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createNoteAntennaCache } from '../../src/platform/note-antennas.js';
import { openUserWebhooks } from '../../src/platform/user-webhooks.js';
import { openRoleMaterials } from '../../src/platform/role-materials.js';
import { role, assignment } from './role/fixtures.js';
import type { InternalEvents } from '../../src/platform/internal-events.js';
import type { EntityManager } from 'typeorm';
import type { Redis } from 'ioredis';
const fixture = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/internal-events/source-observations.json', import.meta.url), 'utf8'));

test('15 pinned-source warm-cache projections match consumer effects on the next operation', async () => {
	const handlers = new Set<Parameters<InternalEvents['register']>[0]>();
	const events: InternalEvents = { register(handler) {
		handlers.add(handler); handler.onReady?.(); return () => {
			handlers.delete(handler);
		};
	}, available: () => true, generation: () => 0, close: async () => {} };
	const redis = { host: 'localhost', port: 6379, db: 0, prefix: 'source' };
	let roleRows: ReturnType<typeof role>[] = []; let assignmentRows: ReturnType<typeof assignment>[] = [];
	const roles = await openRoleMaterials({ events, source: { readRoles: async () => roleRows, readAssignments: async () => assignmentRows }, publisher: { status: 'ready' } as Redis, subscriberConfig: redis, config: { rolesTtlMs: 10000, assignmentsTtlMs: 10000, assignmentsMaxEntries: 10 } });
	const delivered: { id: string; secret: string; on: string[] }[] = [];
	const hooks = await openUserWebhooks({ events, manager: { getRepository: () => ({ findBy: async () => [] }) } as unknown as EntityManager, redis, url: 'https://source.test:444', timeoutMs: 1000, enqueue: async hook => {
		delivered.push({ id: hook.id, secret: hook.secret, on: ['note'] });
	} });
	const antennas = createNoteAntennaCache({ reader: { active: async () => [], followings: async () => [] }, redis: { get: async () => null, set: async () => {}, del: async () => {} }, currentTime: () => 0, onError: () => {} });
	const unregister = events.register({ onInternal: antennas.onInternal });
	try {
		await hooks.enqueue('owner', 'note', {}); await antennas.definitions(); await roles.readRoles(); await roles.readAssignments('owner');
		for (const row of fixture.observations) {
			roleRows = row.expected.roles.map((value: { id: string; isAdministrator: boolean }) => role(value));
			assignmentRows = row.expected.assignments.map((value: { id: string; userId: string; roleId: string }) => assignment(value));
			for (const handler of handlers) {
				await handler.onInternal?.(row.envelope.payload.message);
			}
			delivered.length = 0; await hooks.enqueue('owner', 'note', {});
			expect(delivered, row.type).toEqual(row.expected.hooks);
			expect((await antennas.definitions()).map(({ id, withReplies }) => ({ id, withReplies })), row.type).toEqual(row.expected.antennas);
			expect((await roles.readRoles()).map(({ id, isAdministrator }) => ({ id, isAdministrator })), row.type).toEqual(row.expected.roles);
			expect((await roles.readAssignments('owner')).map(({ id, userId, roleId }) => ({ id, userId, roleId })), row.type).toEqual(row.expected.assignments);
		}
	} finally {
		unregister(); await antennas.close(); await hooks.close(); await roles.close();
	}
});
