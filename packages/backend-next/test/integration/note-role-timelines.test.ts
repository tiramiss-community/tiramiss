/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiChannel, MiMeta, MiNote, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createRoleTimelineReader } from '../../src/platform/database/role-timelines.js';
import { createTestDatabase } from '../helpers/database.js';
import type { NotePostSaveInput } from '../../src/modules/note/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
let timeline: Redis;
let subscriber: Redis;
const codec = createIdCodec('aidx');
const id = () => codec.newId(Date.now());
const users: Record<string, { id: string; token: string }> = {};
const logs: string[] = [];
const events: { channel: string; message: { type: string; body: Record<string, unknown> } }[] = [];
const list = (roleId: string) => timeline.lrange(`list:roleTimeline:${roleId}`, 0, -1);

async function create(input: object = {}) {
	const response = await app.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i: users.alice.token, text: 'role timeline', localOnly: true, ...input }) });
	expect(response.status, await response.clone().text()).toBe(200);
	const result = await response.json();
	await resources.notePostSave.idle();
	// A command on the subscribed connection is ordered after the received publications.
	await subscriber.ping();
	return result.createdNote;
}

async function role(options: Partial<MiRole> = {}, assigned = true, expiresAt: Date | null = null) {
	const roleId = id();
	await resources.dataSource.getRepository(MiRole).insert({ id: roleId, name: 'timeline role', description: '', updatedAt: new Date(), lastUsedAt: new Date(), ...options });
	if (assigned) {
		await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: id(), roleId, userId: users.alice.id, expiresAt });
	}
	return roleId;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.redisForTimelines = { ...database.config.redis, db: 6, prefix: `${database.config.redis.prefix}-role`, keyPrefix: `${database.config.redis.prefix}-role:` };
	resources = await connectResources(database.config, createLogger('role-timeline-test', line => logs.push(line)));
	timeline = new Redis(database.config.redisForTimelines);
	subscriber = new Redis(database.config.redisForPubsub);
	subscriber.on('message', (_channel, payload) => {
		const event = JSON.parse(payload);
		if (event.channel?.startsWith('roleTimelineStream:')) {
			events.push(event);
		}
	});
	await subscriber.subscribe(new URL(database.config.url).host);
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	app = createBackendHttpApp(resources, database.config);
});

beforeEach(async () => {
	await resources.notePostSave.idle();
	await resources.notePostDelete.idle();
	await resources.dataSource.query('TRUNCATE role CASCADE');
	await resources.roleMaterials.changes.invalidateLocal({ kind: 'role-definitions-changed', roleId: '' });
	for (const name of ['alice', 'bob']) {
		const userId = id();
		users[name] = { id: userId, token: `t${userId.slice(1)}` };
		const username = `${name}${userId}`;
		await resources.dataSource.getRepository(MiUser).insert({ ...users[name], username, usernameLower: username });
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: true, rootUserId: users.alice.id });
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isBot: false, isCat: false, isExplorable: true, notesCount: 0, followersCount: 0, followingCount: 0 });
	logs.length = 0;
	events.length = 0;
});

afterAll(async () => {
	subscriber?.disconnect();
	timeline?.disconnect();
	await resources?.close();
	await database?.close();
});

test.each(['public', 'home', 'followers', 'specified'])('ordinary HTTP %s produces full private-role envelope with fanout disabled', async visibility => {
	const roleId = await role({ isPublic: false, isExplorable: false });
	await resources.dataSource.getRepository(MiMeta).update('singleton', { enableFanoutTimeline: false });
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isExplorable: false });
	const note = await create({ visibility, ...(visibility === 'specified' ? { visibleUserIds: [users.bob.id] } : {}) });
	expect(await list(roleId)).toEqual([note.id]);
	expect(await resources.redis.lrange(`list:roleTimeline:${roleId}`, 0, -1)).toEqual([]);
	expect(events).toEqual([{ channel: `roleTimelineStream:${roleId}`, message: { type: 'note', body: expect.objectContaining({ id: note.id, text: 'role timeline', visibility, user: expect.objectContaining({ id: users.alice.id }) }) } }]);
});

test('channel notes still produce Role timeline independently of ordinary channel fanout', async () => {
	const roleId = await role();
	const channelId = id();
	await resources.dataSource.getRepository(MiChannel).insert({ id: channelId, userId: users.alice.id, name: 'role channel' });
	const note = await create({ channelId });
	expect(await list(roleId)).toEqual([note.id]);
	expect(events[0].message.body.channelId).toBe(channelId);
});

test('live materials preserve assigned order then matching conditional duplicates and expire at evaluation time', async () => {
	const manual = await role();
	const conditional = await role({ target: 'conditional', condFormula: { id: 'condition', type: 'isLocal' } });
	const falseAssigned = await role({ target: 'conditional', condFormula: { id: 'condition', type: 'isRemote' } });
	const expired = await role({}, true, new Date(0));
	const note = await create();
	expect(await list(manual)).toEqual([note.id]);
	expect(await list(conditional)).toEqual([note.id, note.id]);
	expect(await list(falseAssigned)).toEqual([note.id]);
	expect(await list(expired)).toEqual([]);
	const reader = createRoleTimelineReader(resources.dataSource.manager, resources.roleMaterials, codec.createdAtFromId);
	const expires = Date.now() + 100000;
	const later = await role({}, true, new Date(expires));
	await resources.roleMaterials.changes.invalidateLocal({ kind: 'role-definitions-changed', roleId: '' });
	const freshUser = id();
	await resources.dataSource.getRepository(MiUser).insert({ id: freshUser, username: 'expiry', usernameLower: 'expiry' });
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: id(), roleId: later, userId: freshUser, expiresAt: new Date(expires) });
	expect(await reader.roleIds(freshUser, expires - 1)).toContain(later);
	expect(await reader.roleIds(freshUser, expires)).not.toContain(later);
	expect(await reader.roleIds(freshUser, expires + 1)).not.toContain(later);
	const roles = await resources.roleMaterials.readRoles();
	const assignedOrder = roles.filter(value => [manual, conditional, falseAssigned].includes(value.id)).map(value => value.id);
	expect(events.map(event => event.channel)).toEqual([...assignedOrder, conditional].map(value => `roleTimelineStream:${value}`));
});

test('current user facts and existing role update invalidation affect the next post', async () => {
	const roleId = await role({ target: 'conditional', condFormula: { id: 'condition', type: 'isBot' } }, false);
	const before = await create();
	expect(await list(roleId)).toEqual([]);
	await resources.dataSource.getRepository(MiUser).update(users.alice.id, { isBot: true });
	const bot = await create();
	expect(await list(roleId)).toEqual([bot.id]);
	const response = await app.request('/api/admin/roles/update', { method: 'POST', body: JSON.stringify({ i: users.alice.token, roleId, condFormula: { id: 'condition', type: 'isRemote' } }) });
	expect(response.status, await response.clone().text()).toBe(204);
	const after = await create();
	expect(await list(roleId)).toEqual([bot.id]);
	expect(events.map(event => event.message.body.id)).not.toEqual(expect.arrayContaining([before.id, after.id]));
});

test('conditional adapter supplies every current user fact and keeps strict creation boundaries', async () => {
	const userId = users.alice.id;
	const createdAt = codec.createdAtFromId(userId);
	const now = createdAt + 10000;
	await resources.dataSource.getRepository(MiUser).update(userId, { isSuspended: true, isLocked: true, isBot: true, isCat: true, isExplorable: false, followersCount: 10, followingCount: 20, notesCount: 30 });
	const conditions: MiRole['condFormula'][] = [
		{ id: 'condition', type: 'isLocal' }, { id: 'condition', type: 'not', value: { id: 'condition', type: 'isRemote' } }, { id: 'condition', type: 'isSuspended' }, { id: 'condition', type: 'isLocked' }, { id: 'condition', type: 'isBot' }, { id: 'condition', type: 'isCat' },
		{ id: 'condition', type: 'not', value: { id: 'condition', type: 'isExplorable' } }, { id: 'condition', type: 'followersMoreThanOrEq', value: 10 }, { id: 'condition', type: 'followingLessThanOrEq', value: 20 }, { id: 'condition', type: 'notesMoreThanOrEq', value: 30 },
	];
	const all = await role({ target: 'conditional', condFormula: { id: 'condition', type: 'and', values: conditions } }, false);
	const less = await role({ target: 'conditional', condFormula: { id: 'condition', type: 'createdLessThan', sec: 10 } }, false);
	const more = await role({ target: 'conditional', condFormula: { id: 'condition', type: 'createdMoreThan', sec: 10 } }, false);
	const reader = createRoleTimelineReader(resources.dataSource.manager, resources.roleMaterials, codec.createdAtFromId);
	expect(await reader.roleIds(userId, now)).toEqual([all]);
	expect(await reader.roleIds(userId, now - 1)).toEqual([all, less]);
	expect(await reader.roleIds(userId, now + 1)).toEqual([all, more]);
});

test('forced trim uses max1000 and WRONGTYPE preserves siblings, publication and HTTP success', async () => {
	const broken = await role();
	const healthy = await role();
	await timeline.set(`list:roleTimeline:${broken}`, 'wrongtype');
	await timeline.lpush(`list:roleTimeline:${healthy}`, ...Array.from({ length: 1001 }, (_, i) => `old${i}`));
	const random = vi.spyOn(Math, 'random').mockReturnValue(0);
	try {
		const note = await create();
		expect(await timeline.llen(`list:roleTimeline:${healthy}`)).toBe(1000);
		expect((await list(healthy))[0]).toBe(note.id);
		expect(events.map(event => event.channel).sort()).toEqual([broken, healthy].map(value => `roleTimelineStream:${value}`).sort());
		expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: note.id })).toBe(true);
		expect(logs.some(line => JSON.parse(line).event === 'note-post-save.failed')).toBe(true);
		expect(logs.join('\n')).not.toContain(users.alice.token);
	} finally {
		random.mockRestore();
	}
});

test('deletion leaves role IDs and delayed post-save reuses the captured packed snapshot', async () => {
	const roleId = await role();
	const original = await create();
	let saved!: NotePostSaveInput;
	const spy = vi.spyOn(resources.notePostSave, 'start').mockImplementation(value => {
		saved = value;
	});
	let delayed: { id: string };
	try {
		delayed = await create();
	} finally {
		spy.mockRestore();
	}
	for (const note of [original, delayed]) {
		const response = await app.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: users.alice.token, noteId: note.id }) });
		expect(response.status).toBe(204);
	}
	await resources.notePostDelete.idle();
	resources.notePostSave.start(saved);
	await resources.notePostSave.idle();
	await subscriber.ping();
	expect(await list(roleId)).toEqual([delayed.id, original.id]);
	expect(await resources.dataSource.getRepository(MiNote).existsBy({ id: delayed.id })).toBe(false);
	expect(events.at(-1)?.message.body).toMatchObject({ id: delayed.id, text: 'role timeline' });
});

test('manual-only membership does not depend on a User lookup, conditional membership requires user facts', async () => {
	await role();
	const reader = createRoleTimelineReader(resources.dataSource.manager, resources.roleMaterials, codec.createdAtFromId);
	const missingUser = id();
	expect(await reader.roleIds(missingUser, Date.now())).toEqual([]);
	await role({ target: 'conditional', condFormula: { id: 'condition', type: 'isLocal' } }, false);
	resources.roleMaterials.changes.invalidateLocal({ kind: 'role-definitions-changed', roleId: '' });
	await expect(reader.roleIds(missingUser, Date.now())).rejects.toThrow();
});
