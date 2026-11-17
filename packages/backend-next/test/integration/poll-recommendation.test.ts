/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiBlocking, MiChannel, MiMeta, MiMuting, MiNote, MiPoll, MiPollVote, MiUser } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: ReturnType<typeof serve>;
let origin: string;
const now = Date.parse('2026-11-17T00:00:00.000Z');
const codec = createIdCodec('aidx');
const viewer = codec.newId(now - 20000);
const author = codec.newId(now - 19000);
const remote = codec.newId(now - 18000);
const muted = codec.newId(now - 17000);
const expiredMute = codec.newId(now - 16000);
const blocked = codec.newId(now - 15000);
const channel = codec.newId(now - 14000);
const token = 'native0000000489';
const ids = Array.from({ length: 125 }, (_, i) => codec.newId(now - 10000 + i * 10));
const eligible = [114, 113, 112, 111, 110, ...Array.from({ length: 110 }, (_, i) => 109 - i)];
const indices = (result: string[]) => result.map(id => ids.indexOf(id));

async function call(input: object = {}, credential: string | null = token) {
	return fetch(`${origin}/api/notes/polls/recommendation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, ...(credential === null ? {} : { i: credential }) }) });
}

async function list(input: object = {}) {
	const response = await call(input);
	expect(response.status).toBe(200);
	return indices((await response.json()).map((note: { id: string }) => note.id));
}

async function snapshot() {
	const result: Record<string, object[]> = {};
	for (const [name, entity, key] of [['notes', MiNote, 'id'], ['polls', MiPoll, 'noteId'], ['votes', MiPollVote, 'id'], ['mutings', MiMuting, 'id']] as const) {
		result[name] = await resources.dataSource.getRepository(entity).createQueryBuilder('row').orderBy(`row.${key}`, 'ASC').getMany();
	}
	return result;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('poll-recommendation', () => {}));
	const db = resources.dataSource;
	await db.getRepository(MiMeta).insert({ id: 'singleton', ugcVisibilityForVisitor: 'none' });
	await db.getRepository(MiUser).insert([
		{ id: viewer, username: 'viewer', usernameLower: 'viewer', token },
		{ id: author, username: 'author', usernameLower: 'author', requireSigninToViewContents: true },
		{ id: remote, username: 'remote', usernameLower: 'remote', host: 'remote.test' },
		{ id: muted, username: 'muted', usernameLower: 'muted' },
		{ id: expiredMute, username: 'expiredmute', usernameLower: 'expiredmute' },
		{ id: blocked, username: 'blocked', usernameLower: 'blocked', isSuspended: true },
	]);
	await db.getRepository(MiChannel).insert({ id: channel, userId: author, name: 'polls' });
	const noteAuthor = (i: number) => i === 115 ? viewer : i === 116 ? remote : i === 123 ? muted : i === 124 ? expiredMute : i === 112 ? blocked : author;
	const visibility = (i: number): 'public' | 'home' | 'followers' | 'specified' => i === 117 ? 'home' : i === 118 ? 'followers' : i === 119 ? 'specified' : 'public';
	await db.getRepository(MiNote).insert(ids.map((id, i) => ({ id, userId: noteAuthor(i), userHost: i === 116 ? 'remote.test' : null,
																																																													text: `poll ${i}`, hasPoll: true, visibility: visibility(i), channelId: i === 110 ? channel : null, localOnly: i === 111 })));
	await db.getRepository(MiPoll).insert(ids.map((noteId, i) => ({ noteId, userId: noteAuthor(i), userHost: i === 116 ? 'remote.test' : null,
																																																																	noteVisibility: visibility(i), channelId: i === 110 ? channel : null, choices: ['a', 'b'], votes: [0, 0], multiple: false,
																																																																	expiresAt: i === 120 ? new Date(now - 1) : i === 121 ? new Date(now) : i === 114 ? new Date(now + 1) : null })));
	await db.getRepository(MiPollVote).insert([
		{ id: codec.newId(now), userId: viewer, noteId: ids[122], choice: 0 },
		{ id: codec.newId(now), userId: remote, noteId: ids[113], choice: 0 },
	]);
	await db.getRepository(MiMuting).insert([
		{ id: codec.newId(now), muterId: viewer, muteeId: muted },
		{ id: codec.newId(now), muterId: viewer, muteeId: expiredMute, expiresAt: new Date(now - 1) },
	]);
	await db.getRepository(MiBlocking).insert({ id: codec.newId(now), blockerId: viewer, blockeeId: blocked });
	await db.getRepository(MiAccessToken).insert([
		{ id: codec.newId(now), userId: viewer, token: 'poll-read-account-token', hash: 'poll-read-account-token', permission: ['read:account'] },
		{ id: codec.newId(now), userId: viewer, token: 'poll-no-scope-token', hash: 'poll-no-scope-token', permission: [] },
	]);
	vi.spyOn(Date, 'now').mockReturnValue(now);
	const app = createBackendHttpApp(resources, database.config);
	server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
	await new Promise<void>(resolve => server.on('listening', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('no HTTP address');
	}
	origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	vi.restoreAllMocks();
	await new Promise<void>((resolve, reject) => server ? server.close(error => error ? reject(error) : resolve()) : resolve());
	await resources?.close();
	await database?.close();
});

test('filters precede pagination, strict expiry excludes equality, and only the viewer vote/mute excludes', async () => {
	const before = await snapshot();
	expect(await list()).toEqual(eligible.slice(0, 10));
	expect(await list({ limit: 100 })).toEqual(eligible.slice(0, 100));
	expect(await list({ offset: 2, limit: 3 })).toEqual([112, 111, 110]);
	expect(await list({ excludeChannels: true, limit: 5 })).toEqual([114, 113, 112, 111, 109]);
	expect(await list({ excludeChannels: false, offset: 4, limit: 1 })).toEqual([110]);
	expect(await list({ offset: 10000 })).toEqual([]);
	expect(await snapshot()).toEqual(before);
});

test('uses authenticated detail rendering even when guest UGC is none and author requires sign in', async () => {
	const response = await call({ limit: 1 }, 'poll-read-account-token');
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject([{ id: ids[114], text: 'poll 114', userId: author, poll: {
		multiple: false, expiresAt: new Date(now + 1).toISOString(), choices: [{ text: 'a', votes: 0, isVoted: false }, { text: 'b', votes: 0, isVoted: false }],
	} }]);
});

test.skipIf(!process.env.BACKEND_NEXT_UPSTREAM_PATH)('pinned source callback selects the same PostgreSQL rows and leaves business tables unchanged', async () => {
	const before = await snapshot();
	const inputs = [{}, { limit: 1 }, { limit: 100 }, { offset: 2, limit: 3 }, { excludeChannels: true, limit: 5 },
																	{ excludeChannels: false, offset: 4, limit: 1 }, { offset: 110 }, { offset: 10000 }, { offset: -1 }];
	const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../../../docs/superpowers/compatibility/poll-recommendation/source-probe.mjs', import.meta.url)), '--pg'], {
		input: JSON.stringify({ database: database.config.database, now, viewerId: viewer, inputs }), encoding: 'utf8',
	}));
	const observations = [];
	for (const item of result.observations) {
		const response = await call(item.input);
		if (item.error) {
			expect(response.status).toBe(500);
			expect(await response.json()).toHaveProperty('error.code', 'INTERNAL_ERROR');
			observations.push({ input: item.input, sourceError: item.error, httpStatus: response.status });
		} else {
			expect(response.status).toBe(200);
			const received = (await response.json()).map((note: { id: string }) => note.id);
			expect(received).toEqual(item.ids);
			if (item.ids.length) {
				expect(item.packed).toEqual({ viewerId: viewer, options: { detail: true } });
			} else {
				expect(item.packed).toBeNull();
			}
			observations.push({ input: item.input, ids: indices(received), authenticatedDetail: item.packed !== null, httpStatus: response.status });
		}
	}
	expect(await snapshot()).toEqual(before);
	if (process.env.POLL_RECOMMENDATION_WRITE_EVIDENCE) {
		writeFileSync(new URL('../../../../docs/superpowers/compatibility/poll-recommendation/pg-observations.json', import.meta.url), JSON.stringify({
			identity: result.identity, now, observations, persistenceUnchanged: true, scope: 'Literal upstream callback against the same PostgreSQL rows; packMany ID double compared with backend-next normal listening HTTP. Full upstream server/packer is not measured.',
		}, null, 2) + '\n');
	}
});

test.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: 0.5 }, { excludeChannels: 'true' }, { excludeChannels: null }])('invalid input %j', async input => {
	const response = await call(input);
	expect(response.status).toBe(400);
	expect(await response.json()).toHaveProperty('error.code', 'INVALID_PARAM');
});

test('anonymous HTTP body/status matches the pinned credential gate and ApiError', async () => {
	const expected = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/poll-recommendation/auth-observations.json', import.meta.url), 'utf8'));
	const before = await snapshot();
	const response = await call({ limit: 0 }, null);
	expect(response.status).toBe(expected.status);
	expect(await response.json()).toEqual(expected.body);
	expect(await snapshot()).toEqual(before);
});

test.each([
	{ credential: null, status: 401, code: 'CREDENTIAL_REQUIRED' },
	{ credential: 'invalid', status: 401, code: 'AUTHENTICATION_FAILED' },
	{ credential: 'poll-no-scope-token', status: 403, code: 'PERMISSION_DENIED' },
])('authentication precedes invalid input: $code', async ({ credential, status, code }) => {
	const response = await call({ limit: 0 }, credential);
	expect(response.status).toBe(status);
	expect(await response.json()).toHaveProperty('error.code', code);
	expect(response.headers.get('www-authenticate')).toContain('Bearer');
});

test('suspension precedes invalid input; POST-only route preserves common CORS', async () => {
	await resources.dataSource.getRepository(MiUser).update(viewer, { isSuspended: true });
	try {
		const response = await call({ limit: 0 });
		expect(response.status).toBe(403);
		expect(await response.json()).toHaveProperty('error.code', 'YOUR_ACCOUNT_SUSPENDED');
	} finally {
		await resources.dataSource.getRepository(MiUser).update(viewer, { isSuspended: false });
	}
	expect((await fetch(`${origin}/api/notes/polls/recommendation`)).status).toBe(405);
	expect((await call()).headers.get('access-control-allow-origin')).toBe('*');
});

test('concurrent deletion between Poll selection and Note refetch yields no root without material reads', async () => {
	const repository = resources.dataSource.getRepository(MiPoll);
	const original = repository.createQueryBuilder.bind(repository);
	const spy = vi.spyOn(repository, 'createQueryBuilder').mockImplementation((...args) => {
		const query = original(...args);
		if (args[0] === 'poll') {
			const getMany = query.getMany.bind(query);
			query.getMany = async () => {
				const selected = await getMany();
				await resources.dataSource.getRepository(MiNote).delete(ids[114]);
				return selected;
			};
		}
		return query;
	});
	try {
		expect(await list({ limit: 1 })).toEqual([]);
	} finally {
		spy.mockRestore();
	}
});
