/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { openRoleMaterials } from '../../src/platform/role-materials.js';
import { openNoteAntennas } from '../../src/platform/note-antennas.js';
import { openUserWebhooks } from '../../src/platform/user-webhooks.js';
import { deferred, role, assignment } from './role/fixtures.js';
import type { AntennaDefinition } from '../../src/modules/note/public.js';
import type { InternalEvents } from '../../src/platform/internal-events.js';
import type { Redis } from 'ioredis';
import type { EntityManager } from 'typeorm';

function transport() {
	const handlers = new Set<Parameters<InternalEvents['register']>[0]>();
	let generation = 0; let available = true;
	const events: InternalEvents = {
		register(handler) {
			handlers.add(handler); handler.onReady?.(); return () => {
				handlers.delete(handler);
			};
		},
		available: () => available, generation: () => generation, close: vi.fn(async () => {}),
	};
	return {
		events, handlers,
		send(type: string, body: Record<string, unknown>) {
			for (const h of handlers) {
				void h.onInternal?.({ type, body });
			}
		},
		lost() {
			generation++; available = false; for (const h of handlers) {
				h.onLost?.();
			}
		},
		ready() {
			for (const h of handlers) {
				h.onReady?.();
			}
		},
		ack() {
			available = true;
		},
	};
}

const redis = { host: 'localhost', port: 6379, db: 0, prefix: 'test' };
const hook = { id: 'h', userId: 'owner', active: true, on: ['note'], url: 'https://hook.test', secret: '' };

test('all Role internal changes invalidate trusted DB materials and assignment targets without owning shared transport', async () => {
	const t = transport();
	const source = { readRoles: vi.fn(async () => [role()]), readAssignments: vi.fn(async (userId: string) => [assignment({ userId })]) };
	const cache = await openRoleMaterials({ events: t.events, source, publisher: { status: 'ready' } as Redis, subscriberConfig: redis, config: { rolesTtlMs: 1000, assignmentsTtlMs: 1000, assignmentsMaxEntries: 10 } });
	try {
		await cache.readRoles(); await cache.readAssignments('a'); await cache.readAssignments('b');
		for (const type of ['roleCreated', 'roleUpdated', 'roleDeleted', 'policiesUpdated']) {
			t.send(type, { id: 'untrusted' }); await cache.readRoles();
		}
		expect(source.readRoles).toHaveBeenCalledTimes(5);
		for (const type of ['userRoleAssigned', 'userRoleUnassigned']) {
			t.send(type, { id: 'assignment', userId: 'a' }); await cache.readAssignments('a'); await cache.readAssignments('b');
		}
		expect(source.readAssignments.mock.calls.map(args => args[0])).toEqual(['a', 'b', 'a', 'a']);
		t.send('roleUpdated', {}); t.send('userRoleAssigned', { userId: [] }); await cache.readRoles();
		expect(source.readRoles).toHaveBeenCalledTimes(5);
		const pendingRead = deferred<ReturnType<typeof role>[]>(); source.readRoles.mockReturnValueOnce(pendingRead.promise);
		t.send('roleUpdated', { id: 'r' }); const pending = cache.readRoles(); await Promise.resolve();
		t.lost(); t.ready(); pendingRead.resolve([role()]);
		await expect(pending).rejects.toThrow('unavailable'); await expect(cache.readRoles()).rejects.toThrow('unavailable');
		t.ack(); await cache.readRoles();
	} finally {
		await cache.close();
	}
	expect(t.handlers.size).toBe(0); expect(t.events.close).not.toHaveBeenCalled();
});

test('late webhook registration clears on its first raw ready before ACK, while antenna retains warm cache', async () => {
	const t = transport(); const enqueue = vi.fn(async () => {});
	const findBy = vi.fn().mockResolvedValueOnce([hook]).mockResolvedValue([]);
	const webhooks = await openUserWebhooks({ events: t.events, manager: { getRepository: () => ({ findBy }) } as unknown as EntityManager, redis, url: 'https://host.test', timeoutMs: 100, enqueue });
	const antenna: AntennaDefinition = { id: 'a', userId: 'owner', src: 'all', userListId: null, users: [], keywords: [], excludeKeywords: [], caseSensitive: false, excludeBots: false, withReplies: true, withFile: false, isActive: true, localOnly: false, excludeNotesInSensitiveChannel: false };
	const antennas = await openNoteAntennas({ events: t.events, reader: { active: async () => [antenna], followings: async () => [] }, redis: { get: async () => null, set: async () => {}, del: async () => {} }, currentTime: () => 0, onError: () => {}, subscriberConfig: redis, url: 'https://host.test', timeoutMs: 100 });
	try {
		await webhooks.enqueue('owner', 'note', {}); await antennas.definitions();
		t.lost(); t.ready();
		await webhooks.enqueue('owner', 'note', {});
		expect(enqueue).toHaveBeenCalledTimes(1); expect(await antennas.definitions()).toEqual([antenna]);
		await webhooks.close(); expect(t.handlers.size).toBe(1);
		t.send('antennaDeleted', { id: 'a' }); expect(await antennas.definitions()).toEqual([]);
	} finally {
		await webhooks.close(); await antennas.close();
	}
	expect(t.handlers.size).toBe(0); expect(t.events.close).not.toHaveBeenCalled();
});

test('webhook update during fetch discards old snapshot; antenna retains its intentional cold-fetch overwrite', async () => {
	const t = transport(); const oldHooks = deferred<typeof hook[]>(); const enqueue = vi.fn(async () => {});
	const findBy = vi.fn().mockReturnValueOnce(oldHooks.promise).mockResolvedValue([]);
	const hooks = await openUserWebhooks({ events: t.events, manager: { getRepository: () => ({ findBy }) } as unknown as EntityManager, redis, url: 'https://host.test', timeoutMs: 100, enqueue });
	const oldAntennas = deferred<AntennaDefinition[]>();
	const antennas = await openNoteAntennas({ events: t.events, reader: { active: () => oldAntennas.promise, followings: async () => [] }, redis: { get: async () => null, set: async () => {}, del: async () => {} }, currentTime: () => 0, onError: () => {}, subscriberConfig: redis, url: 'https://host.test', timeoutMs: 100 });
	try {
		const h = hooks.enqueue('owner', 'note', {}); const a = antennas.definitions();
		t.send('webhookUpdated', { ...hook, active: false }); t.send('antennaCreated', { id: 'new' });
		oldHooks.resolve([hook]); oldAntennas.resolve([{ id: 'snapshot' } as AntennaDefinition]); await h; await a;
		expect(enqueue).not.toHaveBeenCalled(); expect(await antennas.definitions()).toEqual([{ id: 'snapshot' }]);
		for (const body of [{}, { id: 'x', active: true, on: null }]) {
			t.send('webhookCreated', body); t.send('antennaCreated', body);
		}
		await hooks.enqueue('owner', 'note', {}); expect(enqueue).not.toHaveBeenCalled();
	} finally {
		await hooks.close(); await antennas.close();
	}
});
