/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { request, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiMeta, MiUser, MiUserProfile, MiUserKeypair } from 'backend-upstream/entities';
import { createTestDatabase } from '../helpers/database.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { createLogger } from '../../src/platform/logger.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';

const evidence = new URL('../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('local-actor-alias-key-corpus.json', evidence), 'utf8')) as { cases: Array<{ id: string; path: string; method?: string; accept?: string; kind?: string; federation?: string; allow?: boolean }> };
const source = JSON.parse(readFileSync(new URL('local-actor-alias-key-observations.json', evidence), 'utf8'));
const key = JSON.parse(readFileSync(new URL('local-actor-alias-key-key.json', evidence), 'utf8'));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let origin: string;
let privateKey: string;
let reads: string[] = [];
const ordinary = ['alias', 'double-at', 'self', 'remote', 'extra-at', 'encoded', 'invalid', 'utf8', 'alias-missing', 'alias-suspended', 'alias-none', 'key-local', 'key-missing', 'key-suspended', 'key-remote', 'key-path-46', 'key-path-47', 'key-path-48', 'key-path-49', 'key-path-50', 'key-none'];
const cases = corpus.cases.filter(c => ordinary.includes(c.id) || c.id.startsWith('key-accept-') || c.id.startsWith('alias-accept-') || c.id.startsWith('guard-2') || c.id === 'guard-30');

beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	database.config.url = 'https://local.test';
	resources = await connectResources(database.config, createLogger('alias-key-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	privateKey = (await generateRsaKeyPair()).privateKeyPem;
	const original = resources.dataSource.logger.logQuery.bind(resources.dataSource.logger);
	vi.spyOn(resources.dataSource.logger, 'logQuery').mockImplementation((sql, params, runner) => {
		reads.push(sql); original(sql, params, runner);
	});
	vi.spyOn(resources.outboundHttp, 'getJson').mockImplementation(async () => {
		throw Error('GET must not fetch remote JSON');
	});
	vi.spyOn(resources.outboundHttp, 'getHtml').mockImplementation(async () => {
		throw Error('GET must not fetch remote HTML');
	});
	vi.spyOn(resources.outboundHttp, 'send').mockImplementation(async () => {
		throw Error('GET must not resolve remote');
	});
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close(); await database?.close(); vi.restoreAllMocks();
});

async function seed(kind?: string) {
	await resources.dataSource.getRepository(MiUserKeypair).deleteAll();
	await resources.dataSource.getRepository(MiUserProfile).deleteAll();
	await resources.dataSource.getRepository(MiUser).deleteAll();
	if (kind === 'missing') {
		return;
	}
	await resources.dataSource.getRepository(MiUser).insert({ id: 'local', username: 'Alice', usernameLower: 'alice', host: kind === 'remote' ? 'remote.test' : null, uri: kind === 'remote' ? 'https://remote.test/actor' : null, isSuspended: kind === 'suspended' });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: 'local' });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: 'local', publicKey: key.pkcs1, privateKey });
}

async function state() {
	return Promise.all([resources.dataSource.getRepository(MiUser).find(), resources.dataSource.getRepository(MiUserProfile).find(), resources.dataSource.getRepository(MiUserKeypair).find()]);
}

test.each(cases)('$id real listening HTTP/PG consumes source result and preserves ordinary business state', async row => {
	const expected = source.cases.find((x: { id: string }) => x.id === row.id);
	await seed(row.path.includes('remote.test') ? 'remote' : row.kind);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: row.federation === 'none' ? 'none' : 'all', allowExternalApRedirect: row.allow ?? true });
	const before = await state();
	const queueKeys = await resources.redis.keys(`${database.config.redis.prefix}:queue:*`);
	reads = [];
	const response = await fetch(origin + row.path, { headers: { Accept: row.accept ?? 'application/activity+json' }, redirect: 'manual' });
	expect(response.status).toBe(expected.status);
	const body = await response.text();
	if (!(expected.status === 404 && expected.calls.length === 0)) {
		for (const [name, value] of Object.entries(expected.headers)) {
			expect(response.headers.get(name), name).toBe(value);
		}
		if (response.status === 200) {
			const json = JSON.parse(body); const want = JSON.parse(expected.body);
			expect(row.path.startsWith('/@') ? { '@context': json['@context'], type: json.type, id: json.id, publicKey: json.publicKey } : json).toEqual(want);
		} else if (!response.headers.get('content-type')?.startsWith('application/json')) {
			expect(body).toBe(expected.body);
		}
	}
	expect(reads.filter(sql => /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql))).toEqual([]);
	expect(await state()).toEqual(before);
	expect(await resources.redis.keys(`${database.config.redis.prefix}:queue:*`)).toEqual(queueKeys);
	expect(resources.outboundHttp.send).not.toHaveBeenCalled();
	expect(resources.outboundHttp.getJson).not.toHaveBeenCalled();
	expect(resources.outboundHttp.getHtml).not.toHaveBeenCalled();
});

test('actual repository preserves remote host case and rejects absent remote without resolution', async () => {
	await seed('remote'); await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	for (const acct of ['Alice@REMOTE.test', 'Alice@unknown.test', 'Alice%2540remote.test']) {
		const response = await fetch(`${origin}/@${acct}`, { headers: { Accept: 'application/activity+json' }, redirect: 'manual' });
		expect(response.status).toBe(404);
	}
	expect(resources.outboundHttp.send).not.toHaveBeenCalled();
	expect(resources.outboundHttp.getJson).not.toHaveBeenCalled();
	expect(resources.outboundHttp.getHtml).not.toHaveBeenCalled();
});

test('local suspended key does not require profile and actual cold modern-key GET only fills Redis', async () => {
	await seed('suspended'); await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	await resources.dataSource.getRepository(MiUserProfile).deleteAll();
	const id = 'keyonly'; await resources.dataSource.getRepository(MiUser).insert({ id, username: id, usernameLower: id, isSuspended: true });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: id, publicKey: key.pkcs1, privateKey });
	reads = [];
	const response = await fetch(`${origin}/users/${id}/publickey`);
	expect(response.status).toBe(200);
	expect(reads.filter(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toEqual([]);
	expect(reads.some(sql => sql.includes('user_profile'))).toBe(false);
	const cached = await resources.redis.get(`kvcache:userKeypair:v2:${id}`);
	expect(JSON.parse(cached!).publicKey).toBe(key.pkcs1);
});

test('legacy private-key upgrade finishes once and warm GET retains the upgraded row', async () => {
	await seed(); await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	const id = 'legacy';
	await resources.dataSource.getRepository(MiUser).insert({ id, username: 'legacy', usernameLower: 'legacy' });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: id, publicKey: key.pkcs1, privateKey: createPrivateKey(privateKey).export({ type: 'pkcs1', format: 'pem' }).toString() });
	reads = [];
	expect((await fetch(`${origin}/users/${id}/publickey`)).status).toBe(200);
	await vi.waitFor(async () => expect((await resources.dataSource.getRepository(MiUserKeypair).findOneByOrFail({ userId: id })).privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/));
	expect(reads.filter(sql => /^UPDATE /i.test(sql))).toHaveLength(1);
	const before = await state(); reads = [];
	expect((await fetch(`${origin}/users/${id}/publickey`)).status).toBe(200);
	expect(reads.filter(sql => /^(UPDATE|INSERT|DELETE) /i.test(sql))).toEqual([]);
	expect(await state()).toEqual(before);
});

test('missing Meta retains existing initialization rather than an unconditional no-write claim', async () => {
	await resources.dataSource.getRepository(MiMeta).deleteAll(); reads = [];
	const response = await fetch(`${origin}/users/local/publickey`);
	expect(response.status).toBe(403);
	expect(await resources.dataSource.getRepository(MiMeta).count()).toBe(1);
	expect(reads.some(sql => /^INSERT /i.test(sql))).toBe(true);
});

test.each(['missing', 'invalid'])('actual %s stored key preserves the source exception/cache boundary', async kind => {
	await resources.dataSource.getRepository(MiMeta).deleteAll();
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	const id = `key-${kind}`;
	await resources.dataSource.getRepository(MiUser).insert({ id, username: id, usernameLower: id });
	if (kind === 'invalid') {
		await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: id, publicKey: 'invalid', privateKey });
	}
	const expected = source.cases.find((c: { id: string }) => c.id === `key-key-${kind}`);
	reads = [];
	const response = await fetch(`${origin}/users/${id}/publickey`);
	expect(response.status).toBe(expected.status);
	expect(response.headers.get('cache-control')).toBe(expected.headers['cache-control']);
	expect(await response.json()).toMatchObject(JSON.parse(expected.body));
	expect(reads.filter(sql => /^(INSERT|UPDATE|DELETE) /i.test(sql))).toEqual([]);
});

test.each(corpus.cases.filter(row => row.id.startsWith('review-')))('$id raw HTTP routing and lookup boundary', async row => {
	const expected = source.cases.find((x: { id: string }) => x.id === row.id);
	await seed('missing');
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: row.federation === 'none' ? 'none' : 'all' });
	reads = [];
	const response = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const req = request(origin, { path: row.path, method: row.method, headers: { Accept: 'application/activity+json' } }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', chunk => {
				body += chunk;
			});
			res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on('error', reject);
		req.end();
	});
	expect(response.status).toBe(expected.status);
	for (const [name, value] of Object.entries(expected.headers)) {
		expect(response.headers[name] ?? null, name).toBe(value);
	}
	if (row.method === 'HEAD') {
		expect(response.body).toBe('');
	}
	if (expected.status === 414) {
		expect(reads).toEqual([]);
	}
});
