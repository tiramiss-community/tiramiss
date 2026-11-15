/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterEach, expect, test, vi } from 'vitest';
import { openInternalEvents, roleMaterialTopic } from '../../src/platform/internal-events.js';
import { openRoleMaterials } from '../../src/platform/role-materials.js';
import { openUserWebhooks } from '../../src/platform/user-webhooks.js';
import { openNoteAntennas } from '../../src/platform/note-antennas.js';
import { testConfig } from '../helpers/database.js';
import { role, assignment, deferred } from '../unit/role/fixtures.js';
import type { EntityManager } from 'typeorm';
import type { AntennaDefinition } from '../../src/modules/note/public.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) {
		await close();
	}
});

async function setup() {
	const config = testConfig(); const name = `events290-${randomUUID()}`;
	const publisher = new Redis({ ...config.redis, lazyConnect: true }); await publisher.connect();
	cleanup.push(async () => {
		publisher.disconnect();
	});
	const errors: unknown[] = [];
	const events = await openInternalEvents({ subscriberConfig: { ...config.redis, connectionName: name }, url: config.url, privateRoleTopic: roleMaterialTopic(config.redis.prefix), onError: error => {
		errors.push(error);
	} });
	cleanup.push(events.close);
	return { config, publisher, events, name, errors,
		publish: (type: string, body: object) => publisher.publish('example.test', JSON.stringify({ channel: 'internal', message: { type, body } })),
		client: async () => String(await publisher.client('LIST')).split('\n').find(line => line.includes(`name=${name} `)),
	};
}

const antenna: AntennaDefinition = { id: 'a', userId: 'owner', src: 'all', userListId: null, users: [], keywords: [], excludeKeywords: [], caseSensitive: false, excludeBots: false, withReplies: true, withFile: false, isActive: true, localOnly: false, excludeNotesInSensitiveChannel: false };
const hook = { id: 'h', userId: 'owner', url: 'https://hook.test', secret: 'first', active: true, on: ['note'] };

test('one real Redis connection fans out to three consumers, survives unregister and isolates failed handlers and invalid traffic', async () => {
	const f = await setup();
	const reads = { readRoles: vi.fn(async () => [role()]), readAssignments: vi.fn(async (userId: string) => [assignment({ userId })]) };
	const roles = await openRoleMaterials({ events: f.events, source: reads, publisher: f.publisher, subscriberConfig: f.config.redis, config: f.config.roleCache }); cleanup.push(roles.close);
	const delivered: string[] = [];
	const hooks = await openUserWebhooks({ events: f.events, manager: { getRepository: () => ({ findBy: async () => [hook] }) } as unknown as EntityManager, redis: f.config.redis, url: f.config.url, timeoutMs: 1000, enqueue: async value => {
		delivered.push(value.secret);
	} }); cleanup.push(hooks.close);
	const antennas = await openNoteAntennas({ events: f.events, reader: { active: async () => [antenna], followings: async () => [] }, redis: f.publisher, subscriberConfig: f.config.redis, url: f.config.url, timeoutMs: 1000, currentTime: Date.now, onError: error => {
		throw error;
	} }); cleanup.push(antennas.close);
	await roles.readRoles(); await roles.readAssignments('owner'); await hooks.enqueue('owner', 'note', {}); await antennas.definitions();
	const bad = f.events.register({ onInternal: async () => {
		throw new Error('one consumer');
	} });
	for (const payload of ['null', '[]', '{', JSON.stringify({ channel: 'internal', message: { type: 'webhookUpdated', body: null } })]) {
		await f.publisher.publish('example.test', payload);
	}
	await f.publisher.publish('different-host', JSON.stringify({ channel: 'internal', message: { type: 'antennaDeleted', body: { id: 'a' } } }));
	await f.publish('webhookUpdated', { ...hook, secret: 'second' });
	await vi.waitFor(async () => {
		delivered.length = 0; await hooks.enqueue('owner', 'note', {}); expect(delivered).toEqual(['second']);
	});
	await f.publish('antennaUpdated', { ...antenna, id: 'b' });
	await vi.waitFor(async () => expect((await antennas.definitions()).map(value => value.id)).toEqual(['a', 'b']));
	await f.publish('roleUpdated', { id: 'r' });
	await vi.waitFor(async () => {
		await roles.readRoles(); expect(reads.readRoles).toHaveBeenCalledTimes(2);
	});
	await f.publish('userRoleUnassigned', { id: 'assignment', userId: 'owner' });
	await vi.waitFor(async () => {
		await roles.readAssignments('owner'); expect(reads.readAssignments).toHaveBeenCalledTimes(2);
	});
	bad(); expect(f.errors.length).toBeGreaterThan(0);
	await hooks.close(); await roles.close(); expect(await f.client()).toBeDefined();
	await f.publish('antennaDeleted', { id: 'a' }); await vi.waitFor(async () => expect((await antennas.definitions()).map(value => value.id)).toEqual(['b']));
	await antennas.close(); expect(await f.client()).toBeDefined(); await f.events.close(); expect(await f.client()).toBeUndefined();
});

test('real reconnect raw ready clears webhook before held ACK; Role stays unavailable and antenna retains warmed definitions', async () => {
	const f = await setup(); const loaded = vi.fn(async () => [role()]);
	const roles = await openRoleMaterials({ events: f.events, source: { readRoles: loaded, readAssignments: async () => [] }, publisher: f.publisher, subscriberConfig: f.config.redis, config: f.config.roleCache }); cleanup.push(roles.close);
	let rows = [hook]; const delivered: string[] = [];
	const hooks = await openUserWebhooks({ events: f.events, manager: { getRepository: () => ({ findBy: async () => rows }) } as unknown as EntityManager, redis: f.config.redis, url: f.config.url, timeoutMs: 1000, enqueue: async value => {
		delivered.push(value.id);
	} }); cleanup.push(hooks.close);
	const antennas = await openNoteAntennas({ events: f.events, reader: { active: async () => [antenna], followings: async () => [] }, redis: f.publisher, subscriberConfig: f.config.redis, url: f.config.url, timeoutMs: 1000, currentTime: Date.now, onError: () => {} }); cleanup.push(antennas.close);
	await roles.readRoles(); await hooks.enqueue('owner', 'note', {}); await antennas.definitions(); rows = [];
	const ack = deferred<void>(); const release = deferred<void>(); const original = Redis.prototype.subscribe;
	const spy = vi.spyOn(Redis.prototype, 'subscribe').mockImplementation(async function(this: Redis, ...args: Parameters<Redis['subscribe']>) {
		const value = await original.apply(this, args); ack.resolve(); await release.promise; return value;
	});
	try {
		const line = (await f.client())!; await f.publisher.client('KILL', 'ID', line.match(/^id=(\d+)/)![1]); await ack.promise;
		await hooks.enqueue('owner', 'note', {}); expect(delivered).toEqual(['h']);
		await expect(roles.readRoles()).rejects.toThrow('unavailable'); expect(await antennas.definitions()).toEqual([antenna]);
		release.resolve(); await vi.waitFor(async () => {
			await roles.readRoles(); expect(loaded).toHaveBeenCalledTimes(2);
		});
	} finally {
		release.resolve(); spy.mockRestore();
	}
});
