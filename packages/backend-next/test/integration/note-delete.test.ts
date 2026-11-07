/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiAccessToken, MiChannel, MiFollowing, MiRelay, MiUserKeypair, MiMeta, MiModerationLog, MiNote, MiNoteReaction, MiPoll, MiPollVote, MiRole, MiRoleAssignment, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const actors = new Map<string, { id: string; token: string }>();
const logs: string[] = [];
const id = () => codec.newId(Date.now());

async function note(owner = 'alice', fields: Partial<MiNote> = {}) {
	const row = { id: id(), userId: actors.get(owner)!.id, text: 'delete me', visibility: 'public' as const, localOnly: true, ...fields };
	await resources.dataSource.getRepository(MiNote).insert(row);
	return row.id;
}

function call(noteId: unknown, actor = 'alice', extra: object = {}, authorization?: string) {
	return app.request('/api/notes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify({ i: actors.get(actor)?.token, noteId, ...extra }) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('delete-test', line => logs.push(line)));
	for (const [index, name] of ['alice', 'bob', 'moderator', 'moved', 'suspended'].entries()) {
		const user = { id: id(), token: `delete${String(index).padStart(10, '0')}` };
		actors.set(name, user);
		await resources.dataSource.getRepository(MiUser).insert({ ...user, username: `probe_${name}`, usernameLower: `probe_${name}`, isSuspended: name === 'suspended', movedToUri: name === 'moved' ? 'https://remote.test/moved' : null });
	}
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', rootUserId: actors.get('moderator')!.id });
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: id(), userId: actors.get('alice')!.id, token: 'delete-no-scope', hash: 'delete-no-scope', permission: [] });
	app = createBackendHttpApp(resources, database.config);
});
afterAll(async () => {
	await resources?.close(); await database?.close();
});

test('C10 other, author, repeat and deleted show match fixed upstream', async () => {
	const target = await note();
	for (const [key, actor] of [['C10-other', 'bob'], ['C10-author', 'alice'], ['C10-repeat', 'alice']]) {
		const response = await call(target, actor);
		const body = response.status === 204 ? null : await response.json();
		expect({ status: response.status, body }).toEqual(golden[key]);
	}
	const response = await app.request('/api/notes/show', { method: 'POST', body: JSON.stringify({ i: actors.get('alice')!.token, noteId: target }) });
	expect(response.status).toBe(400);
	expect((await response.json()).error.code).toBe('NO_SUCH_NOTE');
});
test('moved author may delete, suspended/scope credentials fail before input validation', async () => {
	const response = await call(await note('moved'), 'moved');
	expect({ status: response.status, body: response.status === 204 ? null : await response.json() }).toEqual(golden['C2-moved-delete']);
	for (const [extra, actor, expected] of [[{}, 'suspended', 'YOUR_ACCOUNT_SUSPENDED'], [{ i: 'delete-no-scope' }, 'alice', 'PERMISSION_DENIED'], [{ i: 'wrong' }, 'alice', 'AUTHENTICATION_FAILED'], [{ i: null }, 'alice', 'CREDENTIAL_REQUIRED']] as const) {
		const result = await call(null, actor, extra);
		expect((await result.json()).error.code).toBe(expected);
	}
	expect((await call('unknown', 'alice', {}, 'Bearer invalid')).status).toBe(401);
	expect((await call('unknown', 'alice', { i: false })).status).toBe(400);
});
test('moderator audit retains the entire deleted row and author information', async () => {
	const target = await note();
	const before = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: target });
	expect((await call(target, 'moderator')).status).toBe(204);
	await resources.notePostDelete.idle();
	const audit = await resources.dataSource.getRepository(MiModerationLog).findOneByOrFail({ userId: actors.get('moderator')!.id, type: 'deleteNote' });
	expect(audit.info).toEqual({ noteId: target, noteUserId: actors.get('alice')!.id, noteUserUsername: 'probe_alice', noteUserHost: null, note: JSON.parse(JSON.stringify(before)) });
});
test('current expired moderator assignment is denied without waiting for role cache TTL', async () => {
	const roleId = id();
	await resources.dataSource.getRepository(MiRole).insert({ id: roleId, name: 'moderator', description: '', isModerator: true, updatedAt: new Date(), lastUsedAt: new Date() });
	const assignment = id();
	await resources.dataSource.getRepository(MiRoleAssignment).insert({ id: assignment, userId: actors.get('bob')!.id, roleId, expiresAt: null });
	expect((await call(await note(), 'bob')).status).toBe(204);
	await resources.dataSource.getRepository(MiRoleAssignment).update(assignment, { expiresAt: new Date(0) });
	expect((await call(await note(), 'bob')).status).toBe(400);
});
test('deletion cascades Poll, leaves referring notes and only decrements reply count', async () => {
	const parent = await note('bob', { repliesCount: 3, renoteCount: 7 });
	const channel = id();
	await resources.dataSource.getRepository(MiChannel).insert({ id: channel, name: 'counter-test', userId: actors.get('alice')!.id, notesCount: 5, usersCount: 2 });
	const target = await note('alice', { replyId: parent, renoteId: parent, hasPoll: true, channelId: channel });
	await resources.dataSource.getRepository(MiPoll).insert({ noteId: target, userId: actors.get('alice')!.id, choices: ['a', 'b'], votes: [0, 0], multiple: false, noteVisibility: 'public' });
	await resources.dataSource.getRepository(MiPollVote).insert({ id: id(), noteId: target, userId: actors.get('bob')!.id, choice: 0 });
	await resources.dataSource.getRepository(MiNoteReaction).insert({ id: id(), noteId: target, userId: actors.get('bob')!.id, reaction: '👍' });
	const child = await note('bob', { replyId: target, renoteId: target });
	const userBefore = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.get('alice')!.id });
	expect((await call(target)).status).toBe(204);
	expect(await resources.dataSource.getRepository(MiPoll).findOneBy({ noteId: target })).toBeNull();
	expect(await resources.dataSource.getRepository(MiPollVote).countBy({ noteId: target })).toBe(0);
	expect(await resources.dataSource.getRepository(MiNoteReaction).countBy({ noteId: target })).toBe(0);
	expect(await resources.dataSource.getRepository(MiChannel).findOneByOrFail({ id: channel })).toMatchObject({ notesCount: 5, usersCount: 2 });
	expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: child })).toMatchObject({ replyId: target, renoteId: target });
	expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: parent })).toMatchObject({ repliesCount: 2, renoteCount: 7 });
	expect((await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: userBefore.id })).notesCount).toBe(userBefore.notesCount);
});
test('a failed DELETE leaves note and earlier reply decrement, without moderator audit', async () => {
	const parent = await note('bob', { repliesCount: 3 });
	const remote = id();
	await resources.dataSource.getRepository(MiUser).insert({ id: remote, username: 'failure-remote', usernameLower: 'failure-remote', host: 'failure.test', uri: 'https://failure.test/user', inbox: 'https://failure.test/personal', sharedInbox: 'https://failure.test/shared' });
	await resources.dataSource.getRepository(MiFollowing).insert({ id: id(), followerId: remote, followeeId: actors.get('alice')!.id, followerHost: 'failure.test', followerInbox: 'https://failure.test/personal', followerSharedInbox: 'https://failure.test/shared' });
	await resources.dataSource.getRepository(MiRelay).insert({ id: id(), inbox: 'https://relay-failure.test/inbox', status: 'accepted' });
	const keys = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/ap-request/test-only-keypair.json', import.meta.url), 'utf8'));
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: actors.get('alice')!.id, publicKey: keys.publicKeyPem, privateKey: keys.privateKeyPem });
	const target = await note('alice', { replyId: parent, localOnly: false, mentionedRemoteUsers: JSON.stringify([{ uri: 'https://failure.test/user', host: 'failure.test', username: 'failure-remote' }]) });
	await resources.dataSource.query(`CREATE FUNCTION fail_note_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${target}' THEN RAISE EXCEPTION 'injected delete failure'; END IF; RETURN OLD; END $$`);
	await resources.dataSource.query('CREATE TRIGGER fail_note_delete BEFORE DELETE ON note FOR EACH ROW EXECUTE FUNCTION fail_note_delete()');
	try {
		const before = await resources.dataSource.getRepository(MiModerationLog).count();
		expect((await call(target, 'moderator')).status).toBe(500);
		await resources.notePostDelete.idle();
		expect(await resources.dataSource.getRepository(MiNote).findOneBy({ id: target })).not.toBeNull();
		expect((await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: parent })).repliesCount).toBe(2);
		expect(await resources.dataSource.getRepository(MiModerationLog).count()).toBe(before);
		const jobs = await queued(target);
		expect(jobs.map(job => job.to).sort()).toEqual(['https://failure.test/personal', 'https://failure.test/shared', 'https://relay-failure.test/inbox']);
		const relay = jobs.find(job => job.to === 'https://relay-failure.test/inbox')!;
		expect(JSON.parse(relay.content).signature.creator).toBe(`${database.config.url}/users/${actors.get('alice')!.id}#main-key`);
	} finally {
		await resources.dataSource.query('DROP TRIGGER fail_note_delete ON note');
		await resources.dataSource.query('DROP FUNCTION fail_note_delete()');
	}
});

test('production minInterval and hourly quota run before input validation and use a separate delete key', async () => {
	const mode = process.env.NODE_ENV;
	const { createNoteDeleteRateLimiter } = await import('../../src/platform/note-delete-rate-limit.js');
	process.env.NODE_ENV = 'production';
	const production = createBackendHttpApp(resources, database.config);
	const limiter = createNoteDeleteRateLimiter(resources.redis);
	try {
		const input = JSON.stringify({ i: actors.get('alice')!.token });
		const first = await production.request('/api/notes/delete', { method: 'POST', body: input });
		expect((await first.json()).error.code).toBe('INVALID_PARAM');
		const next = await production.request('/api/notes/delete', { method: 'POST', body: input });
		const body = await next.json();
		expect(next.status).toBe(429);
		expect(body.error).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef' });
		expect(body.error.info.resetMs).toBeGreaterThan(Date.now());
		expect(Number(next.headers.get('retry-after'))).toBeGreaterThanOrEqual(0);
		const limited = id();
		await limiter(limited, 300);
		// Expire only the short window to exercise the independent hour quota without a 300s sleep.
		await resources.redis.del(`limit:${limited}:notes/delete:min`);
		await expect(limiter(limited, 300)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', info: { total: 1 } });
		await expect(limiter(limited, 0)).resolves.toBeUndefined();
	} finally {
		process.env.NODE_ENV = mode;
	}
});

test('concerned recipients use stored URI, renote author and remaining remote reply/renote authors', async () => {
 const { createNoteDeleter, readDeletionConcernedUsers } = await import('../../src/platform/database/note-deleter.js');
 const users: string[] = [];
 for (let i = 0; i < 4; i++) {
  const userId = id(); users.push(userId);
  await resources.dataSource.getRepository(MiUser).insert({ id: userId, host: 'remote.test', username: `remote${i}`, usernameLower: `remote${i}`, uri: `https://remote.test/users/${i}`, inbox: `https://remote.test/inbox/${i}`, sharedInbox: 'https://remote.test/inbox' });
 }
 const target = await note('alice', { mentionedRemoteUsers: JSON.stringify([{ uri: 'https://remote.test/users/0', host: 'old.test', username: 'old-name' }]), renoteUserId: users[1] });
 await resources.dataSource.getRepository(MiNote).insert([
  { id: id(), userId: users[2], userHost: 'remote.test', text: 'reply', visibility: 'public', replyId: target },
  { id: id(), userId: users[3], userHost: 'remote.test', text: null, visibility: 'public', renoteId: target },
 ]);
 const snapshot = await createNoteDeleter(resources.dataSource.manager, codec.createdAtFromId).readNote(target);
 expect(snapshot).not.toBeNull();
 expect((await call(target)).status).toBe(204);
 const concerned = await readDeletionConcernedUsers(resources.dataSource.manager, snapshot!);
 expect(concerned.map(user => user.id).sort()).toEqual([...users].sort());
	const standalone = await note('alice', { localOnly: false });
	await resources.dataSource.getRepository(MiNote).insert([
		{ id: id(), userId: users[2], userHost: 'remote.test', text: 'reply', visibility: 'public', replyId: standalone },
		{ id: id(), userId: users[3], userHost: 'remote.test', text: null, visibility: 'public', renoteId: standalone },
		{ id: id(), userId: actors.get('bob')!.id, userHost: null, text: 'local reply', visibility: 'public', replyId: standalone },
	]);
	expect((await call(standalone)).status).toBe(204);
	await resources.notePostDelete.idle();
	const jobs = await queued(standalone);
	expect(jobs.filter(job => job.to.startsWith('https://remote.test/')).map(job => job.to).sort()).toEqual(['https://remote.test/inbox/2', 'https://remote.test/inbox/3']);
	expect(jobs.some(job => job.content.includes(actors.get('bob')!.id))).toBe(false);
});

async function queued(noteId: string): Promise<{ to: string; content: string }[]> {
 const inspect = new Queue('deliver', baseQueueOptions(database.config.redisForJobQueue, 'deliver', 5000));
 try {
 return (await inspect.getJobs(['waiting'])).map(job => job.data).filter(data => data.content.includes(`/notes/${noteId}`));
} finally {
 await inspect.close();
}
}

test('pure Renote original SELECT failure preserves the already-published deleted stream and stored Note', async () => {
	const original = await note('bob');
	const target = await note('alice', { text: null, renoteId: original, localOnly: false });
	const subscriber = new Redis({ ...database.config.redisForPubsub, keyPrefix: undefined });
	const messages: { channel: string; message: { type: string } }[] = [];
	subscriber.on('message', (_channel, value) => messages.push(JSON.parse(value)));
	await subscriber.subscribe(new URL(database.config.url).host);
	const repository = resources.dataSource.getRepository(MiNote);
	const findOneBy = repository.findOneBy.bind(repository);
	const failing = vi.spyOn(repository, 'findOneBy').mockImplementation(async where => {
		if (!Array.isArray(where) && where.id === original) {
			throw new Error('injected original SELECT failure');
		}
		return findOneBy(where);
	});
	const audits = await resources.dataSource.getRepository(MiModerationLog).count();
	const started = vi.spyOn(resources.notePostDelete, 'start');
	const http = createBackendHttpApp(resources, database.config);
	try {
		const response = await http.request('/api/notes/delete', { method: 'POST', body: JSON.stringify({ i: actors.get('moderator')!.token, noteId: target }) });
		expect(response.status).toBe(500);
		await resources.notePostDelete.idle();
		await vi.waitFor(() => expect(messages.filter(message => message.channel === `noteStream:${target}`).map(message => message.message.type)).toEqual(['deleted']));
		expect(await repository.existsBy({ id: target })).toBe(true);
		expect(await resources.dataSource.getRepository(MiModerationLog).count()).toBe(audits);
		expect(await queued(target)).toEqual([]);
		expect(started.mock.calls.map(([work]) => work.kind)).toEqual(['stream']);
	} finally {
		failing.mockRestore(); started.mockRestore(); subscriber.disconnect();
	}
});

test.each(['localOnly', 'remote', 'denied'] as const)('pure Renote %s deletion never needs the original SELECT', async kind => {
	const original = await note('bob');
	let userId = actors.get('alice')!.id;
	if (kind === 'remote') {
		userId = id();
		await resources.dataSource.getRepository(MiUser).insert({ id: userId, username: 'select-remote', usernameLower: 'select-remote', host: 'select-remote.test' });
	}
	const target = await note('alice', { userId, text: null, renoteId: original, localOnly: kind === 'localOnly' });
	const repository = resources.dataSource.getRepository(MiNote);
	const findOneBy = repository.findOneBy.bind(repository);
	let originalQueries = 0;
	const failing = vi.spyOn(repository, 'findOneBy').mockImplementation(async where => {
		if (!Array.isArray(where) && where.id === original) {
			originalQueries++;
			throw new Error('injected unused original SELECT failure');
		}
		return findOneBy(where);
	});
	try {
		const response = await call(target, kind === 'denied' ? 'bob' : 'moderator');
		expect(response.status).toBe(kind === 'denied' ? 400 : 204);
		if (kind === 'denied') {
			expect((await response.json()).error.code).toBe('ACCESS_DENIED');
		}
		await resources.notePostDelete.idle();
		expect(originalQueries).toBe(0);
		expect(await repository.existsBy({ id: target })).toBe(kind === 'denied');
	} finally {
		failing.mockRestore();
	}
});
