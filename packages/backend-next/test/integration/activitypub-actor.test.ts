/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiMeta, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
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
