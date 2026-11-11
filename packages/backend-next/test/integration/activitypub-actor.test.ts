/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiDriveFile, MiEmoji, MiMeta, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import * as federation from '../../src/modules/federation/public.js';
import { loadConfig } from '../../src/config/load-config.js';
import { createRemoteUsers } from '../../src/composition/remote-users.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { createOutboundHttpClient } from '../../src/composition/outbound-http.js';
import { createActivitySession } from '../../src/modules/federation/public.js';
import { listenHttp, closeHttp } from '../../src/processes/http.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { createTestDatabase } from '../helpers/database.js';
import { startRemotePeer, deferred } from '../helpers/remote-peer.js';
import { remoteSource } from '../helpers/remote-source.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let peer: Awaited<ReturnType<typeof startRemotePeer>>;
let port: number;
let signerId: string;
let privateKeyPem: string;
const codec = createIdCodec('aidx');
const ids = new Map<string, string>();
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	database.config.url = 'http://local.test'; peer = await startRemotePeer(); database.config.outboundHttp.proxy = peer.proxy;
	resources = await connectResources(database.config, createLogger('actor-test', () => { }));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton' });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 }); port = (server.address() as { port: number; }).port;
	peer.route('local.test', port);
	for (const fixture of remoteSource.cases.filter((c: { area: string; }) => c.area === 'publication')) {
		if (fixture.input.missing) {
			ids.set(fixture.id, 'missing'); continue;
		}
		const id = codec.newId(Date.now()); ids.set(fixture.id, id);
		const pair = await generateRsaKeyPair();
		await resources.dataSource.getRepository(MiUser).insert({ id, username: fixture.input.system ? 'instance.actor' : 'alice', usernameLower: `${fixture.id}`, name: null, isBot: fixture.input.bot ?? false, isLocked: true, isExplorable: false, ...fixture.input.user });
		await resources.dataSource.getRepository(MiUserProfile).insert({ userId: id });
		await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: id, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
		if (fixture.id === 'publication-local') {
			signerId = id; privateKeyPem = pair.privateKeyPem;
		}
	}
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	} await resources?.close(); await peer?.close(); await database?.close();
});

test.each(remoteSource.cases.filter((c: { area: string; }) => c.area === 'publication'))('$id measures real HTTP negotiation, source row filtering and signer publication', async fixture => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: fixture.input.federation ?? 'all' });
	const response = await fetch(`http://127.0.0.1:${port}/users/${ids.get(fixture.id)}`, { headers: { Accept: fixture.input.accept ?? 'application/activity+json' }, redirect: 'manual' });
	const events = fixture.expected.events;
	const status = events.find((e: { op: string; }) => e.op === 'status')?.args;
	const redirect = events.find((e: { op: string; }) => e.op === 'redirect')?.args;
	if (fixture.id.includes('html')) {
		expect(response.status).toBe(404); return;
	}
	expect(response.headers.get('vary')).toBe('Accept');
	if (redirect) {
		expect(response.status).toBe(301); expect(response.headers.get('location')).toBe(fixture.input.user.uri); return;
	}
	if (status) {
		expect(response.status).toBe(status); return;
	}
	expect(response.status).toBe(200);
	const body = await response.json() as Record<string, unknown>;
	expect(body.type).toBe(fixture.expected.result.type);
	expect(body['@context']).toContain('https://www.w3.org/ns/activitystreams');
	expect(response.headers.get('cache-control')).toBe('public, max-age=180');
	expect(response.headers.get('content-type')).toBe(events.find((e: { op: string; }) => e.op === 'type').args);
	const key = body.publicKey as { id: string; owner: string; publicKeyPem: string; };
	expect(key.owner).toBe(`http://local.test/users/${ids.get(fixture.id)}`); expect(key.id).toBe(key.owner + '#main-key'); expect(key.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
});

function session(signed: boolean, http = resources.outboundHttp) {
	return createActivitySession({
		http, signed, clock: Date.now, isSelfHost: () => false, isAllowedHost: async () => true,
		signer: async () => ({ keyId: `http://local.test/users/${signerId}#main-key`, privateKeyPem }), resolveLocal: async () => {
			throw Error('unexpected local');
		}
	});
}

function activity(url: string, patch: Record<string, unknown> = {}) {
	return { id: url, '@context': 'https://www.w3.org/ns/activitystreams', ...patch };
}

test('real signed GET discovers cold PEM; one same-host HTML alternate is parsed and re-signed', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	peer.clearKeys();
	peer.respond(async req => req.path === '/html' ? { type: 'text/html', body: '<html><head><link rel="alternate" type="application/activity+json" href="http://remote.test/ap"></head></html>' } : { body: activity(`http://remote.test${req.path}`) });
	expect(await session(true).resolve('http://remote.test/html')).toEqual(activity('http://remote.test/ap'));
	expect(peer.requests.slice(-2).map(r => [r.path, r.signature])).toEqual([['/html', true], ['/ap', true]]);
	expect(peer.discoveries.at(-1)?.url).toBe(`http://local.test/users/${signerId}`);
});
test.each(['relative', 'foreign', 'failed'])('real signed alternate %s is swallowed then original HTML content type fails', async kind => {
	peer.respond(async req => req.path === '/html' ? { type: 'text/html', body: `<html><head><link rel="alternate" type="application/activity+json" href="${kind === 'relative' ? '/ap' : kind === 'foreign' ? 'http://other.test/ap' : 'http://remote.test/ap'}"></head></html>` } : { status: 503 });
	await expect(session(true).resolve('http://remote.test/html')).rejects.toThrow('Content type is not');
});
test.each([false, true])('real transport signed=%s enforces identity, content type, context, statuses and strict redirects', async signed => {
	for (const kind of ['content', 'context', 'identity', 'redirect', 'status']) {
		peer.respond(async req => kind === 'status' ? { status: 503 } : kind === 'redirect' && req.path === '/a' ? { status: 302, headers: { Location: 'http://remote.test/b' } } : { type: kind === 'content' ? 'application/json' : 'application/activity+json', body: activity(`http://remote.test${req.path}`, kind === 'context' ? { '@context': 'invalid' } : kind === 'identity' ? { id: 'http://remote.test/other' } : {}) });
		await expect(session(signed).resolve('http://remote.test/a'), kind).rejects.toThrow();
	}
});
test('real streaming caps distinguish unsigned 256KiB from signed 10MiB', async () => {
	peer.respond(async req => ({ body: activity(`http://remote.test${req.path}`, { padding: 'x'.repeat(req.path === '/huge' ? 10485760 : 262144) }) }));
	await expect(session(false).resolve('http://remote.test/large')).rejects.toThrow(/max-size|over limit|size/i);
	expect((await session(true).resolve('http://remote.test/large')).id).toBe('http://remote.test/large');
	await expect(session(true).resolve('http://remote.test/huge')).rejects.toThrow(/max-size|over limit|size/i);
});
test('real 5000ms acquisition timeout cancels the response and normal direct SSRF guard blocks loopback', async () => {
	const gate = deferred();
	peer.respond(async req => {
		await gate.promise; return { body: activity(`http://remote.test${req.path}`) };
	});
	const started = Date.now();
	try {
		await expect(session(false).resolve('http://remote.test/timeout')).rejects.toThrow(/abort/i); expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
	} finally {
		gate.resolve();
	}
	const direct = createOutboundHttpClient({ ...database.config, outboundHttp: {} }, { checkPrivateAddress: true });
	try {
		await expect(direct.send(`http://127.0.0.1:${port}/users/${signerId}`)).rejects.toThrow('Blocked address');
	} finally {
		await direct.close();
	}
});

// Omitting either composition's required reader breaks the real PG-backed consumer below.
test('real Profile row reaches HTTP and actual createRemoteUsers local acquireActor', async () => {
	const { createRemoteUsers } = await import('../../src/composition/remote-users.js');
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	const profile = { description: '**profile**', followedMessage: 'hello', fields: [{ name: 'site', value: 'https://example.com tail' }], birthday: '2000-01-02', location: 'Tokyo' };
	await resources.dataSource.getRepository(MiUserProfile).update(signerId, profile);
	await resources.dataSource.getRepository(MiUser).update(signerId, { name: 'Alice' });
	const response = await fetch(`http://127.0.0.1:${port}/users/${signerId}`, { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ name: 'Alice', summary: '<b>profile</b>', _misskey_summary: '**profile**', _misskey_followedMessage: 'hello', attachment: [{ type: 'PropertyValue', name: 'site', value: '<a href="https://example.com/" rel="me nofollow noopener" target="_blank">https://example.com</a> tail' }], 'vcard:bday': '2000-01-02', 'vcard:Address': 'Tokyo' });
	const remote = createRemoteUsers(resources, database.config);
	const plan = await remote.acquireActor(`http://local.test/users/${signerId}`, null, () => Date.now(), () => 'unused');
	expect(plan.user.name).toBe('Alice');
	expect(plan.profile).toMatchObject({ description: '**profile**', followedMessage: 'hello', birthday: '2000-01-02', location: 'Tokyo', fields: [{ name: 'site', value: '[https://example.com](https://example.com/) tail' }] });
	const repository = resources.dataSource.getRepository(MiUserProfile);
	const fault = vi.spyOn(repository, 'findOneOrFail').mockRejectedValue(new Error('database unavailable'));
	try {
		expect((await fetch(`http://127.0.0.1:${port}/users/${signerId}`, { headers: { Accept: 'application/activity+json' } })).status).toBe(500);
		await expect(remote.acquireActor(`http://local.test/users/${signerId}`, null, () => Date.now(), () => 'unused')).rejects.toThrow('database unavailable');
	} finally {
		fault.mockRestore();
	}
	await resources.dataSource.getRepository(MiUserProfile).delete(signerId);
	expect((await fetch(`http://127.0.0.1:${port}/users/${signerId}`, { headers: { Accept: 'application/activity+json' } })).status).toBe(500);
	await expect(remote.acquireActor(`http://local.test/users/${signerId}`, null, () => Date.now(), () => 'unused')).rejects.toThrow();
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: signerId });
});

// A missing local-only predicate, deduplication or either omitted composition wire changes this public result.
test('stored local actor tags reach actual HTTP and acquireActor without remote-name contamination', async () => {
	const { createRemoteUsers } = await import('../../src/composition/remote-users.js');
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	await resources.dataSource.getRepository(MiUser).update(signerId, { emojis: ['tag_beta', 'absent', 'tag_alpha', 'tag_beta', 'tag_private'], tags: ['MiXeD', '日本 語/#', 'MiXeD'] });
	const repository = resources.dataSource.getRepository(MiEmoji);
	for (const row of [
		{ name: 'tag_alpha', host: null, type: '', publicUrl: 'https://cdn.test/alpha', originalUrl: 'https://original.test/alpha', license: '' },
		{ name: 'tag_beta', host: 'remote.test', type: 'image/png', publicUrl: 'https://remote.test/poison', originalUrl: 'https://remote.test/poison', license: null },
		{ name: 'tag_private', host: null, type: null, publicUrl: 'https://cdn.test/private', originalUrl: '', license: null, localOnly: true },
		{ name: 'tag_beta', host: null, type: null, publicUrl: '', originalUrl: 'https://original.test/beta', license: null },
	]) {
		await repository.insert({ id: codec.newId(Date.now()), updatedAt: new Date('2020-01-02T03:04:05.000Z'), ...row });
	}
	const beta = { id: 'http://local.test/emojis/tag_beta', type: 'Emoji', name: ':tag_beta:', updated: '2020-01-02T03:04:05.000Z', icon: { type: 'Image', mediaType: 'image/png', url: 'https://original.test/beta' }, _misskey_license: { freeText: null } };
	const expected = [beta,
		{ id: 'http://local.test/emojis/tag_alpha', type: 'Emoji', name: ':tag_alpha:', updated: '2020-01-02T03:04:05.000Z', icon: { type: 'Image', mediaType: '', url: 'https://cdn.test/alpha' }, _misskey_license: { freeText: '' } }, beta,
		{ type: 'Hashtag', href: 'http://local.test/tags/MiXeD', name: '#MiXeD' },
		{ type: 'Hashtag', href: 'http://local.test/tags/%E6%97%A5%E6%9C%AC%20%E8%AA%9E%2F%23', name: '#日本 語/#' },
		{ type: 'Hashtag', href: 'http://local.test/tags/MiXeD', name: '#MiXeD' },
	];
	const response = await fetch(`http://127.0.0.1:${port}/users/${signerId}`, { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(200);
	expect((await response.json() as { tag: unknown }).tag).toEqual(expected);
	let acquiredTags: unknown;
	// Observe the actual local resolver at its next external extraction boundary.
	const remote = createRemoteUsers({ ...resources, remoteEmojis: { extract: async tags => {
		acquiredTags = tags;
		return [];
	} } }, database.config);
	const plan = await remote.acquireActor(`http://local.test/users/${signerId}`, null, Date.now, () => 'unused');
	expect(acquiredTags).toEqual(expected);
	expect(plan.user.tags).toEqual(['mixed', '日本 語/#', 'mixed']);
	const fault = vi.spyOn(repository, 'findBy').mockRejectedValue(new Error('emoji database unavailable'));
	const key = vi.spyOn(resources.federationKeys, 'readUserKeypair');
	try {
		const failed = await fetch(`http://127.0.0.1:${port}/users/${signerId}`, { headers: { Accept: 'application/activity+json' } });
		expect(failed.status).toBe(500);
		expect(failed.headers.get('cache-control')).toBeNull();
		await expect(remote.acquireActor(`http://local.test/users/${signerId}`, null, Date.now, () => 'unused')).rejects.toThrow('emoji database unavailable');
		expect(key).not.toHaveBeenCalled();
	} finally {
		fault.mockRestore(); key.mockRestore();
	}
});

const imageSourceRoot = new URL('../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
const imageCorpus = JSON.parse(readFileSync(new URL('local-actor-images-corpus.json', imageSourceRoot), 'utf8'));
const imageSource = JSON.parse(readFileSync(new URL('local-actor-images-observations.json', imageSourceRoot), 'utf8'));

async function normalizedActorConfig(mediaProxy?: string) {
	const dir = await mkdtemp(join(tmpdir(), 'actor-images-config-'));
	try {
		const path = join(dir, 'test.yml');
		await writeFile(path, JSON.stringify({ url: imageCorpus.defaults.config.url, port: 3000, mediaProxy,
			db: { host: database.config.database.host, port: database.config.database.port, db: database.config.database.database, user: database.config.database.username, pass: database.config.database.password },
			redis: { host: database.config.redis.host, port: database.config.redis.port },
		}));
		return await loadConfig({ configFile: path, env: {} });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function seedImageActor(c: ReturnType<typeof JSON.parse>) {
	const id = codec.newId(Date.now());
	const fileIds = new Map<string, string>();
	for (const name of new Set([c.user?.avatarId, c.user?.bannerId].filter(Boolean) as string[])) {
		fileIds.set(name, codec.newId(Date.now()));
	}
	for (const [name, patch] of Object.entries(c.files ?? {})) {
		await resources.dataSource.getRepository(MiDriveFile).insert({
			...imageCorpus.defaults.file, ...patch as object, id: fileIds.get(name)!, userId: signerId,
			name: 'stored-media', type: 'image/png', md5: '0'.repeat(32), size: 123, storedInternal: false,
		});
	}
	const user = { ...imageCorpus.defaults.user, ...c.user, id, emojis: [], tags: [], usernameLower: `images-${id}`,
		avatarId: c.user?.avatarId ? fileIds.get(c.user.avatarId)! : null, bannerId: c.user?.bannerId ? fileIds.get(c.user.bannerId)! : null };
	await resources.dataSource.getRepository(MiUser).insert({ ...user, avatarId: null, bannerId: null });
	await resources.dataSource.manager.transaction(async manager => {
		if ([c.user?.avatarId, c.user?.bannerId].some(name => name && !c.files?.[name])) {
			// Model a damaged historical row in this isolated test DB; restore trigger behavior at transaction end.
			await manager.query('SET LOCAL session_replication_role = replica');
		}
		await manager.getRepository(MiUser).update(id, { avatarId: user.avatarId, bannerId: user.bannerId });
	});
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: id });
	const key = await resources.dataSource.getRepository(MiUserKeypair).findOneByOrFail({ userId: signerId });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: id, publicKey: key.publicKey, privateKey: key.privateKey });
	return { id, fileIds };
}

async function removeImageActor(id: string, fileIds: Map<string, string>) {
	await resources.dataSource.getRepository(MiUser).delete(id);
	for (const fileId of fileIds.values()) {
		await resources.dataSource.getRepository(MiDriveFile).delete(fileId);
	}
}

async function imageActorState(id: string, fileIds: Map<string, string>) {
	return {
		user: await resources.dataSource.getRepository(MiUser).findOneByOrFail({ id }),
		profile: await resources.dataSource.getRepository(MiUserProfile).findOneByOrFail({ userId: id }),
		key: await resources.dataSource.getRepository(MiUserKeypair).findOneByOrFail({ userId: id }),
		files: await Promise.all([...fileIds.values()].map(fileId => resources.dataSource.getRepository(MiDriveFile).findOneBy({ id: fileId }))),
		meta: await resources.dataSource.getRepository(MiMeta).findOneByOrFail({ id: 'singleton' }),
	};
}

// Both real callers must publish the independent source JSON, without acquiring or rewriting media rows.
for (const c of imageCorpus.cases.filter((row: { fail?: unknown; id: string }) => !row.fail && row.id !== 'proxy-encoding-error')) {
	test(`stored actor images ${c.id}: actual HTTP/PG and local acquireActor`, async () => {
		const config = await normalizedActorConfig(c.config?.externalMediaProxyEnabled ? c.config.mediaProxy ?? 'https://proxy.test' : undefined);
		expect(config.noteMedia).toMatchObject(c.config?.externalMediaProxyEnabled
			? { mediaProxy: c.config.mediaProxy ?? 'https://proxy.test', externalMediaProxyEnabled: true }
			: { mediaProxy: 'https://local.test:8443/proxy', externalMediaProxyEnabled: false });
		const { id, fileIds } = await seedImageActor(c);
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all', ...imageCorpus.defaults.meta, ...c.meta });
		const retained = await imageActorState(id, fileIds);
		const expected = imageSource.cases.find((row: { id: string }) => row.id === c.id).expected.json;
		const imageServer = await listenHttp(createBackendHttpApp(resources, config), { port: 0 });
		let document: unknown;
		const originalValidate = federation.validateActor;
		const observe = vi.spyOn(federation, 'validateActor').mockImplementation((value, uri) => {
			document = structuredClone(value);
			return originalValidate(value, uri);
		});
		try {
			const actualPort = (imageServer.address() as { port: number }).port;
			const response = await fetch(`http://127.0.0.1:${actualPort}/users/${id}`, { headers: { Accept: 'application/activity+json' } });
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect({ icon: body.icon, image: body.image }).toEqual(expected);
			expect(response.headers.get('cache-control')).toBe('public, max-age=180');
			const plan = await createRemoteUsers(resources, config).acquireActor(`${config.url}/users/${id}`, null, Date.now, () => 'unused');
			expect(document).toMatchObject(expected);
			expect(plan).toMatchObject({ kind: 'create', bothImagesAbsent: false, user: { avatarId: null, bannerId: null } });
			expect(plan.user).not.toHaveProperty('avatarUrl');
			expect(plan.user).not.toHaveProperty('bannerUrl');
			expect(await imageActorState(id, fileIds)).toEqual(retained);
		} finally {
			observe.mockRestore();
			await closeHttp(imageServer);
			await removeImageActor(id, fileIds);
		}
	});
}

test('actor image eligibility preserves suspended public/internal distinction and all early HTTP branches', async () => {
	const c = imageCorpus.cases.find((row: { id: string }) => row.id === 'avatar-sensitive-null');
	const { id, fileIds } = await seedImageActor(c);
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all', iconUrl: null, bannerUrl: null });
	await resources.dataSource.getRepository(MiUser).update(id, { isSuspended: true });
	const retained = await imageActorState(id, fileIds);
	const originalValidate = federation.validateActor;
	let document: unknown;
	const observe = vi.spyOn(federation, 'validateActor').mockImplementation((value, uri) => {
		document = structuredClone(value); return originalValidate(value, uri);
	});
	const get = (userId = id, accept = 'application/activity+json') => fetch(`http://127.0.0.1:${port}/users/${userId}`, { headers: { Accept: accept }, redirect: 'manual' });
	try {
		expect((await get()).status).toBe(404);
		const plan = await createRemoteUsers(resources, database.config).acquireActor(`http://local.test/users/${id}`, null, Date.now, () => 'unused');
		expect(document).toMatchObject({ icon: { type: 'Image', url: 'https://files.test/original', sensitive: true, name: null }, image: null });
		expect(plan.bothImagesAbsent).toBe(false);
		expect(await imageActorState(id, fileIds)).toEqual(retained);
	} finally {
		observe.mockRestore();
	}
	await resources.dataSource.getRepository(MiUser).update(id, { isSuspended: false });
	const repository = resources.dataSource.getRepository(MiDriveFile);
	const mediaFault = vi.spyOn(repository, 'findOne').mockRejectedValue(new Error('must not acquire media'));
	try {
		expect((await get(id, 'text/html')).status).toBe(404);
		expect((await get(id, 'image/png')).status).toBe(404);
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
		expect((await get()).status).toBe(403);
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
		expect((await get('missing')).status).toBe(404);
		await resources.dataSource.getRepository(MiUser).update(id, { host: 'remote.test', uri: 'https://remote.test/actor' });
		const redirect = await get();
		expect(redirect.status).toBe(301);
		expect(redirect.headers.get('location')).toBe('https://remote.test/actor');
		await expect(createRemoteUsers(resources, database.config).acquireActor(`http://local.test/users/${id}`, null, Date.now, () => 'unused')).rejects.toThrow('local user not found');
		await resources.dataSource.getRepository(MiUser).update(id, { uri: null });
		expect((await get()).status).toBe(500);
		await resources.dataSource.getRepository(MiUser).update(id, { host: 'local.test', uri: 'https://local.test/actor' });
		expect((await get()).status).toBe(500);
		expect(mediaFault).not.toHaveBeenCalled();
	} finally {
		mediaFault.mockRestore();
		await resources.dataSource.getRepository(MiUser).update(id, { host: null, uri: null });
	}
});

test('Drive DB rejection precedes tags/key in both callers and leaves User/Drive/Meta unchanged', async () => {
	const c = imageCorpus.cases.find((row: { id: string }) => row.id === 'both-files');
	const { id, fileIds } = await seedImageActor(c);
	await resources.dataSource.getRepository(MiUser).update(id, { emojis: ['tag_alpha'] });
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	const retained = await imageActorState(id, fileIds);
	const failedConnection = resources.dataSource.createQueryRunner();
	await failedConnection.connect();
	await failedConnection.startTransaction();
	// Exercise a real PostgreSQL failure without changing schema or stored rows.
	await expect(failedConnection.query('SELECT 1 / 0')).rejects.toMatchObject({ driverError: { code: '22012' } });
	const failedFiles = failedConnection.manager.getRepository(MiDriveFile);
	const fault = vi.spyOn(resources.dataSource.getRepository(MiDriveFile), 'findOne').mockImplementation(options => failedFiles.findOne(options));
	const tags = vi.spyOn(resources.dataSource.getRepository(MiEmoji), 'findBy');
	const key = vi.spyOn(resources.federationKeys, 'readUserKeypair');
	try {
		const response = await fetch(`http://127.0.0.1:${port}/users/${id}`, { headers: { Accept: 'application/activity+json' } });
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBeNull();
		await expect(createRemoteUsers(resources, database.config).acquireActor(`http://local.test/users/${id}`, null, Date.now, () => 'unused')).rejects.toMatchObject({ driverError: { code: '25P02' } });
		expect(tags).not.toHaveBeenCalled();
		expect(key).not.toHaveBeenCalled();
	} finally {
		fault.mockRestore(); tags.mockRestore(); key.mockRestore();
		await failedConnection.rollbackTransaction();
		await failedConnection.release();
	}
	expect(await imageActorState(id, fileIds)).toEqual(retained);
});

test('absent optional noteMedia uses local effective defaults for both stored-file callers', async () => {
	const c = imageCorpus.cases.find((row: { id: string }) => row.id === 'external-off-stored');
	const { id, fileIds } = await seedImageActor(c);
	const config = { ...database.config, url: imageCorpus.defaults.config.url, noteMedia: undefined };
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all', ...imageCorpus.defaults.meta });
	const retained = await imageActorState(id, fileIds);
	const imageServer = await listenHttp(createBackendHttpApp(resources, config), { port: 0 });
	const originalValidate = federation.validateActor;
	let document: unknown;
	const observe = vi.spyOn(federation, 'validateActor').mockImplementation((value, uri) => {
		document = structuredClone(value); return originalValidate(value, uri);
	});
	try {
		const actualPort = (imageServer.address() as { port: number }).port;
		const response = await fetch(`http://127.0.0.1:${actualPort}/users/${id}`, { headers: { Accept: 'application/activity+json' } });
		expect(response.status).toBe(200);
		const expected = imageSource.cases.find((row: { id: string }) => row.id === c.id).expected.json;
		expect(await response.json()).toMatchObject(expected);
		const plan = await createRemoteUsers(resources, config).acquireActor(`${config.url}/users/${id}`, null, Date.now, () => 'unused');
		expect(document).toMatchObject(expected);
		expect(plan.bothImagesAbsent).toBe(false);
		expect(await imageActorState(id, fileIds)).toEqual(retained);
	} finally {
		observe.mockRestore();
		await closeHttp(imageServer);
		await removeImageActor(id, fileIds);
	}
});
