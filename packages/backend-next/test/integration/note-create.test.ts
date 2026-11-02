/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiAccessToken, MiApp, MiMeta, MiNote, MiPoll, MiUser, MiRole, MiRoleAssignment } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';

const golden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/observations.json', import.meta.url), 'utf8'));
const rateGolden = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/rate-observations.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/note/http-cases.json', import.meta.url), 'utf8'));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let app: ReturnType<typeof createBackendHttpApp>;
const codec = createIdCodec('aidx');
const actors: Record<string, { id: string; token: string }> = {};
const symbols = new Map<string, string>();

function normalize(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) {
		return value.map(v => normalize(v, key));
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
	}
	if (typeof value === 'string') {
		if (['id', 'userId'].includes(key) && symbols.has(value)) {
			return symbols.get(value);
		}
		return key === 'createdAt' ? '$time' : value.replaceAll(database.config.url, '$origin');
	}
	return value;
}

function call(input: unknown, token: string | null = actors.alice.token, authorization?: string) {
	return app.request('/api/notes/create', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(input && typeof input === 'object' ? { i: token, ...input } : input) });
}

beforeAll(async () => {
	database = await createTestDatabase();
	database.config.url = 'http://127.0.0.1:61167';
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('note-create-test', () => {}));
	const db = resources.dataSource;
	for (const [i, name] of ['alice', 'limited', 'suspended', 'moved'].entries()) {
		const id = codec.newId(Date.now() - 100000);
		actors[name] = { id, token: `native${String(i).padStart(10, '0')}` };
		symbols.set(id, `$${name}`);
		await db.getRepository(MiUser).insert({ id, username: `probe_${name}`, usernameLower: `probe_${name}`, token: actors[name].token, isSuspended: name === 'suspended', movedToUri: name === 'moved' ? 'https://other.test/moved' : null });
	}
	await db.getRepository(MiMeta).insert({ id: 'singleton' });
	const roleId = codec.newId(Date.now());
	await db.getRepository(MiRole).insert({ id: roleId, name: 'limited', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
	await db.query('UPDATE role SET policies=$1 WHERE id=$2', [{ canPublicNote: { useDefault: false, priority: 1, value: false } }, roleId]);
	await db.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), userId: actors.limited.id, roleId });
	for (const [name, permissions, appPermissions] of [
		['noScope', [], null], ['writeScope', ['write:notes'], null], ['appDenied', ['write:notes'], []], ['appWrite', [], ['write:notes']],
	] as const) {
		const appId = appPermissions ? codec.newId(Date.now()) : null;
		if (appId) {
			await db.getRepository(MiApp).insert({ id: appId, name, description: '', secret: 'note-test-only', permission: [...appPermissions!] });
		}
		actors[name] = { id: actors.alice.id, token: `note-access-${name}` };
		await db.getRepository(MiAccessToken).insert({ id: codec.newId(Date.now()), userId: actors.alice.id, appId, token: actors[name].token, hash: `hash-${name}`.toLowerCase(), permission: [...permissions] });
		if (appId) {
			actors[name].token = `HASH-${name.toUpperCase()}`;
		}
	}
	actors.invalid = { id: '', token: 'invalid-token' };
	app = createBackendHttpApp(resources, database.config);
});
afterAll(async () => {
	await resources?.close();
	await database?.close();
});

const pinned = ['C1-basic', 'C2-guest', 'C2-invalid', 'C2-suspended', 'C2-moved', 'C2-no-scope', 'C2-app-denied', 'C2-native', 'C2-scoped', 'C2-app-permission', 'C3-missing', 'C3-whitespace', 'C3-long', 'C3-empty-cw', 'C3-cw-only', 'C4-sensitive', 'C4-policy'];
test.each(pinned)('%s matches fixed upstream HTTP, saved Note and immediate show', async name => {
	const fixture = cases.find((c: { id: string }) => c.id === name);
	const params = structuredClone(fixture.params);
	if (params.text?.$repeat) {
		params.text = params.text.$repeat[0].repeat(params.text.$repeat[1]);
	}
	await resources.dataSource.getRepository(MiMeta).update('singleton', { sensitiveWords: fixture.setup === 'sensitive' ? ['needle'] : [] });
	const before = await resources.dataSource.getRepository(MiNote).count();
	const polls = await resources.dataSource.getRepository(MiPoll).count();
	const response = await call(params, fixture.actor ? actors[fixture.actor].token : null);
	const body = await response.json();
	if (body.createdNote) {
		symbols.set(body.createdNote.id, `$${name}`);
	}
	expect({ status: response.status, body: normalize(body), wwwAuthenticate: response.headers.get('www-authenticate') }).toEqual({ status: golden[name].status, body: golden[name].body, wwwAuthenticate: golden[name].wwwAuthenticate });
	expect(await resources.dataSource.getRepository(MiNote).count() - before).toBe(golden[name].delta.notes);
	expect(await resources.dataSource.getRepository(MiPoll).count() - polls).toBe(0);
	if (body.createdNote) {
		const row = await resources.dataSource.getRepository(MiNote).findOneByOrFail({ id: body.createdNote.id });
		const saved = Object.fromEntries(Object.keys(golden[name].saved).map(key => [key, key === 'poll' ? null : row[key as keyof MiNote]]));
		expect(normalize(saved)).toEqual(golden[name].saved);
		const show = await app.request('/api/notes/show', { method: 'POST', body: JSON.stringify({ noteId: row.id, i: actors.alice.token }) });
		expect(await show.json()).toEqual(body.createdNote);
	}
});

test('Bearer precedence, non-string credentials and browser headers', async () => {
	expect((await call({ text: 'must not save' }, actors.alice.token, 'Bearer invalid-token')).status).toBe(401);
	for (const i of [false, {}, []]) {
		const response = await call({ text: 'must not save', i });
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('');
	}
	const response = await call({ text: 'headers' });
	expect(response.headers.get('access-control-allow-origin')).toBe('*');
	expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
	const options = await app.request('/api/notes/create', { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
	expect(options.status).toBe(204);
});

test('concurrent creates increment the author count once each after saving', async () => {
	await vi.waitFor(async () => {
		const user = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
		expect(user.notesCount).toBe(await resources.dataSource.getRepository(MiNote).countBy({ userId: user.id }));
	});
	const before = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
	const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => call({ text: `parallel ${i}` })));
	expect(responses.map(r => r.status)).toEqual(Array(12).fill(200));
	await vi.waitFor(async () => {
		const user = await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
		expect(user.notesCount).toBe(before.notesCount + 12);
		expect(user.updatedAt).toBeInstanceOf(Date);
	});
});

test.each([{ fileIds: ['missing'] }, { mediaIds: ['missing'] }, { replyId: 'missing' }, { renoteId: 'missing' }, { channelId: 'missing' }, { poll: { choices: ['a', 'b'] } }, { visibleUserIds: ['missing'], visibility: 'specified' }, { text: '@probe_alice' }, { text: '#tag' }, { cw: ':blob:' }])('unsupported input %j is refused without saving a partial post', async params => {
	const before = await resources.dataSource.getRepository(MiNote).count();
	const response = await call({ text: 'do not discard input', ...params });
	expect(response.status).toBe(501);
	expect(await response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
	expect(await resources.dataSource.getRepository(MiNote).count()).toBe(before);
});

test('explicit no-extract preserves literal text and public/basic flags are saved', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { sensitiveWords: [] });
	const response = await call({ text: '  @probe_alice #tag :blob:  ', noExtractMentions: true, noExtractHashtags: true, noExtractEmojis: true, cw: 'cw', localOnly: true, visibility: 'followers', reactionAcceptance: 'likeOnly' });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ createdNote: { text: '@probe_alice #tag :blob:', cw: 'cw', localOnly: true, visibility: 'followers', reactionAcceptance: 'likeOnly' } });
});

test('production rate limit consumes invalid input first and precedes suspended/moved/scope checks', async () => {
	const db = resources.dataSource;
	const roleId = codec.newId(Date.now());
	const userId = codec.newId(Date.now() - 10000);
	const token = 'rate169000000000';
	await db.getRepository(MiUser).insert({ id: userId, username: 'rate169', usernameLower: 'rate169', token });
	await db.getRepository(MiRole).insert({ id: roleId, name: 'rate', description: '', updatedAt: new Date(), lastUsedAt: new Date() });
	await db.query('UPDATE role SET policies=$1 WHERE id=$2', [{ rateLimitFactor: { useDefault: false, priority: 1, value: 300 } }, roleId]);
	await db.getRepository(MiRoleAssignment).insert({ id: codec.newId(Date.now()), roleId, userId });
	resources.roleMaterials.changes.invalidateLocal({ kind: 'role-definitions-changed', roleId });
	vi.stubEnv('NODE_ENV', 'production');
	try {
		const production = createBackendHttpApp(resources, database.config);
		const request = (i: string) => production.request('/api/notes/create', { method: 'POST', body: JSON.stringify({ i }) });
		const first = await request(token);
		expect({ status: first.status, body: await first.json(), wwwAuthenticate: first.headers.get('www-authenticate') }).toEqual(rateGolden['C2-rate-first-invalid']);
		await db.getRepository(MiUser).update(userId, { isSuspended: true, movedToUri: 'https://moved.test/' });
		const second = await request(token);
		expect(second.status).toBe(429);
		const body = await second.json();
		expect(body).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED', info: { total: 1, remaining: 0 } } });
		expect(body.error.info.resetMs).toBeGreaterThan(Date.now());
		expect(body.error.info.reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
		expect({ status: second.status, body: { error: { ...body.error, info: { ...body.error.info, reset: '$future-epoch-seconds', resetMs: '$future-epoch-milliseconds' } } }, wwwAuthenticate: second.headers.get('www-authenticate') }).toEqual(rateGolden['C2-rate-before-input']);
		expect(await db.getRepository(MiNote).countBy({ userId })).toBe(0);
	} finally {
		vi.unstubAllEnvs();
	}
});

test('insert failure returns 500 without Note, post-save count or automatic retry', async () => {
	const db = resources.dataSource;
	const before = await db.getRepository(MiUser).findOneByOrFail({ id: actors.alice.id });
	const notes = await db.getRepository(MiNote).count();
	await db.query('CREATE FUNCTION public.reject_test_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.text = \'fail-insert-169\' THEN RAISE EXCEPTION \'injected Note insert failure\'; END IF; RETURN NEW; END $$');
	await db.query('CREATE TRIGGER reject_test_note BEFORE INSERT ON note FOR EACH ROW EXECUTE FUNCTION public.reject_test_note()');
	try {
		const response = await call({ text: 'fail-insert-169' });
		expect(response.status).toBe(500);
		expect(await db.getRepository(MiNote).count()).toBe(notes);
		expect((await db.getRepository(MiUser).findOneByOrFail({ id: before.id })).notesCount).toBe(before.notesCount);
	} finally {
		await db.query('DROP TRIGGER reject_test_note ON note');
		await db.query('DROP FUNCTION public.reject_test_note()');
	}
});

test('word controls, CW precedence, and Unicode length boundaries reach stored Note', async () => {
	const db = resources.dataSource;
	await db.getRepository(MiMeta).update('singleton', { sensitiveWords: ['needle'], prohibitedWords: ['blocked combo', '/forbidden/i'] });
	try {
		const suppressed = await call({ text: 'needle' });
		expect(await suppressed.json()).toMatchObject({ createdNote: { visibility: 'home' } });
		const cwWins = await call({ text: 'needle', cw: 'safe' });
		expect(await cwWins.json()).toMatchObject({ createdNote: { visibility: 'public' } });
		const before = await db.getRepository(MiNote).count();
		for (const input of [{ text: 'combo', cw: 'blocked ' }, { text: 'Forbidden' }]) {
			const response = await call(input);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 'CONTAINS_PROHIBITED_WORDS' } });
		}
		expect(await db.getRepository(MiNote).count()).toBe(before);
		const max = await call({ text: '😀'.repeat(3000), cw: 'c'.repeat(100) });
		expect(max.status).toBe(200);
		expect(await max.json()).toMatchObject({ createdNote: { text: '😀'.repeat(3000), cw: 'c'.repeat(100) } });
		expect((await call({ text: '😀'.repeat(3001) })).status).toBe(400);
		expect((await call({ text: 'hello', cw: 'c'.repeat(101) })).status).toBe(400);
	} finally {
		await db.getRepository(MiMeta).update('singleton', { sensitiveWords: [], prohibitedWords: [] });
	}
});
