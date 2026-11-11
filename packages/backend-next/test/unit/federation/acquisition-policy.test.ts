/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { generateKeyPairSync } from 'node:crypto';
import { MiMeta } from 'backend-upstream/entities';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createRemoteUsers } from '../../../src/composition/remote-users.js';
import { createOutboundHttpClient } from '../../../src/composition/outbound-http.js';
import { createDataSource } from '../../../src/platform/database/data-source.js';
import { createActivitySession } from '../../../src/modules/federation/public.js';
import { testConfig } from '../../helpers/database.js';
import { plainActor, startRemotePeer } from '../../helpers/remote-peer.js';

let peer: Awaited<ReturnType<typeof startRemotePeer>>;
const clients: ReturnType<typeof createOutboundHttpClient>[] = [];
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeAll(async () => {
	peer = await startRemotePeer();
	peer.route('allowed.test');
	peer.route('www.remote.test');
	peer.route('remote.test.');
});
afterEach(async () => {
	await Promise.all(clients.splice(0).map(client => client.close()));
	peer.requests.length = 0;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(async () => peer.close());

function ports(meta: Partial<MiMeta> = {}, selfUrl = 'http://local.test') {
	const config = testConfig();
	config.url = selfUrl;
	config.outboundHttp.proxy = peer.proxy;
	const dataSource = createDataSource(config.database);
	// Only persistence is supplied; actual composition, policy and HTTP redirects execute.
	vi.spyOn(dataSource.getRepository(MiMeta), 'find').mockResolvedValue([Object.assign(new MiMeta(), {
		id: 'singleton', federation: 'all', signToActivityPubGet: false,
		blockedHosts: [], federationHosts: [], silencedHosts: [], mediaSilencedHosts: [], deliverSuspendedSoftware: [], ...meta,
	})]);
	const outboundHttp = createOutboundHttpClient(config);
	clients.push(outboundHttp);
	return createRemoteUsers({
		logger: { info() { }, error() { } }, remoteEmojis: { extract: async () => [] }, actorInstanceRegistration: { start: () => { } }, userHashtags: {
			start: () => {
				throw Error('unexpected actor mutation');
			}
		}, dataSource, outboundHttp, federationKeys: undefined as never
	}, config);
}

test.each([
	{ federation: 'none' as const },
	{ federation: 'specified' as const, federationHosts: ['allowed.test'] },
	{ blockedHosts: ['remote.test'] },
])('WebFinger refuses an initially denied destination before network I/O: %j', async meta => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	peer.respond(async () => ({ body: { links: [{ rel: 'self', href: 'http://remote.test/users/alice' }] } }));
	await expect(ports(meta).webfinger({ username: 'alice', host: 'remote.test' })).rejects.toThrow('Instance is blocked');
	expect(peer.requests).toHaveLength(0);
});

test('permitted WebFinger retains its resource, Accept header and self-link result', async () => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	peer.respond(async () => ({ body: { links: [{ rel: 'SeLf', href: 'http://remote.test/users/alice' }] } }));
	expect(await ports().webfinger({ username: 'alice', host: 'remote.test' })).toBe('http://remote.test/users/alice');
	expect(peer.requests).toHaveLength(1);
	expect(peer.requests[0].path).toBe('/.well-known/webfinger?resource=acct%3Aalice%40remote.test');
	expect(peer.requests[0].headers.accept).toBe('application/jrd+json, application/json');
});

test.each([
	{ blocked: 'remote.test', destination: 'remote.test.' },
	{ blocked: 'remote.test.', destination: 'remote.test' },
])('WebFinger rejects equivalent DNS root-dot hostnames: $blocked -> $destination', async ({ blocked, destination }) => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	peer.respond(async () => ({ body: { links: [{ rel: 'self', href: 'http://remote.test/users/alice' }] } }));
	await expect(ports({ blockedHosts: [blocked] }).webfinger({ username: 'alice', host: destination })).rejects.toThrow('Instance is blocked');
	expect(peer.requests).toHaveLength(0);
});

test.each([
	{ federation: 'specified' as const, federationHosts: ['remote.test'], destination: 'remote.test.' },
	{ federation: 'specified' as const, federationHosts: ['remote.test.'], destination: 'remote.test' },
])('WebFinger permits equivalent DNS root-dot allowlist entries: %j', async ({ destination, ...meta }) => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	peer.respond(async () => ({ body: { links: [{ rel: 'self', href: 'http://remote.test/users/alice' }] } }));
	expect(await ports(meta).webfinger({ username: 'alice', host: destination })).toBe('http://remote.test/users/alice');
	expect(peer.requests).toHaveLength(1);
});

test.each([
	{ federation: 'none' as const },
	{ federation: 'specified' as const, federationHosts: ['allowed.test'] },
])('a ported local configuration does not treat a foreign ported WebFinger host as self: %j', async meta => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	peer.respond(async () => ({ body: { links: [{ rel: 'self', href: 'http://remote.test/users/alice' }] } }));
	await expect(ports(meta, 'http://local.test:3000').webfinger({ username: 'alice', host: 'remote.test:8080' })).rejects.toThrow('Instance is blocked');
	expect(peer.requests).toHaveLength(0);
});

test.each([
	{ operation: 'webfinger', port: '' },
	{ operation: 'actor', port: '' },
	{ operation: 'webfinger', port: ':8080' },
	{ operation: 'actor', port: ':8080' },
])('$operation rejects a denied redirect with port "$port" before sending to that host', async ({ operation, port }) => {
	vi.stubEnv('MISSKEY_WEBFINGER_USE_HTTP', 'true');
	peer.respond(async req => {
		const host = req.headers.host;
		if (host === 'remote.test' || host === 'allowed.test') {
			return { status: 302, headers: { Location: `http://${host === 'remote.test' ? 'allowed.test' : 'www.remote.test' + port}${req.path}` } };
		}
		return { body: operation === 'webfinger' ? { links: [{ rel: 'self', href: 'http://remote.test/users/alice' }] } : plainActor('http://remote.test', 'alice') };
	});
	const remote = ports({ blockedHosts: ['www.remote.test'] });
	const result = operation === 'webfinger'
		? remote.webfinger({ username: 'alice', host: 'remote.test' })
		: remote.acquireActor('http://remote.test/users/alice', null, Date.now, () => 'new-actor');
	await expect(result).rejects.toThrow('Instance is blocked');
	expect(peer.requests.map(req => req.headers.host)).toEqual(['remote.test', 'allowed.test']);
});

test('permitted actor redirects still pass strict identity and return a creation plan', async () => {
	peer.respond(async req => req.headers.host === 'remote.test'
		? { status: 302, headers: { Location: 'http://www.remote.test/users/alice' } }
		: { body: plainActor('http://remote.test', 'alice') });
	const plan = await ports().acquireActor('http://remote.test/users/alice', null, Date.now, () => 'new-actor');
	expect(plan.uri).toBe('http://remote.test/users/alice');
	expect(peer.requests.map(req => req.headers.host)).toEqual(['remote.test', 'www.remote.test']);
});

test.each([
	{ entry: 'remote.test.', origin: 'http://remote.test' },
	{ entry: 'remote.test', origin: 'http://remote.test.' },
])('actor entry policy and sending agree for DNS root-dot allowlists: $entry -> $origin', async ({ entry, origin }) => {
	peer.respond(async () => ({ body: plainActor(origin, 'alice') }));
	const plan = await ports({ federation: 'specified', federationHosts: [entry] }).acquireActor(`${origin}/users/alice`, null, Date.now, () => 'new-actor');
	expect(plan.uri).toBe(`${origin}/users/alice`);
	expect(peer.requests).toHaveLength(1);
});

test('a ported remote actor is fetched instead of being treated as the ported local instance', async () => {
	const origin = 'http://remote.test:8080';
	peer.respond(async () => ({ body: plainActor(origin, 'alice') }));
	const plan = await ports({ federation: 'specified', federationHosts: ['remote.test'] }, 'http://local.test:3000').acquireActor(`${origin}/users/alice`, null, Date.now, () => 'new-actor');
	expect(plan.uri).toBe(`${origin}/users/alice`);
	expect(peer.requests.map(req => req.headers.host)).toEqual(['remote.test:8080']);
});

test('local user IDs require the same hostname and nondefault port', () => {
	const remote = ports({}, 'http://local.test:3000');
	expect(remote.localId('http://local.test:3000/users/alice')).toBe('alice');
	expect(remote.localId('http://local.test:3001/users/alice')).toBeNull();
	expect(remote.localId('http://remote.test:3000/users/alice')).toBeNull();
});

test('a real local ported actor uses local resolution without network', async () => {
	const url = 'http://local.test:3000/users/alice';
	const session = createActivitySession({
		signed: false, clock: Date.now,
		isSelfHost: host => host === 'local.test:3000', isAllowedHost: async () => true,
		signer: async () => {
			throw new Error('unexpected signer');
		},
		resolveLocal: async uri => ({ id: uri, source: 'local' }),
		http: { send: async () => {
			throw new Error('unexpected network');
		} },
	});
	expect(await session.resolve(url)).toEqual({ id: url, source: 'local' });
});

test.each([false, true])('denied follower collection remains a visibility fallback, refresh=%s', async refresh => {
	peer.respond(async req => req.path === '/followers'
		? { status: 302, headers: { Location: 'http://www.remote.test/followers' } }
		: { body: plainActor('http://remote.test', 'alice', { followers: 'http://remote.test/followers' }) });
	const existing = refresh ? { id: 'existing', username: 'alice', host: 'remote.test', uri: 'http://remote.test/users/alice', lastFetchedAtMs: null, isDeleted: false, tags: [] } : null;
	const plan = await ports({ blockedHosts: ['www.remote.test'] }).acquireActor('http://remote.test/users/alice', existing, Date.now, () => 'new-actor');
	expect(plan.profile.followersVisibility).toBe(refresh ? undefined : 'private');
	expect(plan.uri).toBe('http://remote.test/users/alice');
	expect(peer.requests.map(req => [req.headers.host, req.path])).toEqual([['remote.test', '/users/alice'], ['remote.test', '/followers']]);
});

test.each([
	['https:', 'http:', false],
	['https:', 'https:', true],
	['http:', 'http:', true],
	['http:', 'https:', true],
] as const)('signed HTML alternate %s to %s preserves the transport boundary', async (originalProtocol, alternateProtocol, permitted) => {
	const url = `${originalProtocol}//remote.test/page`;
	const alternate = `${alternateProtocol}//remote.test/users/alice`;
	const requests: string[] = [];
	const session = createActivitySession({
		signed: true, clock: Date.now, isSelfHost: () => false, isAllowedHost: async () => true,
		signer: async () => ({ keyId: 'https://local.test/users/actor#main-key', privateKeyPem }),
		resolveLocal: async () => {
			throw new Error('unexpected local lookup');
		},
		http: {
			send: async target => {
				requests.push(target);
				return {
					status: 200, statusText: 'OK', finalUrl: target,
					header: () => target === url ? 'text/html' : 'application/activity+json',
					text: async () => `<html><head><link rel="alternate" type="application/activity+json" href="${alternate}"></head></html>`,
					json: async () => plainActor(`${alternateProtocol}//remote.test`, 'alice'),
				};
			},
		},
	});
	if (permitted) {
		expect((await session.resolve(url)).id).toBe(alternate);
	} else {
		await expect(session.resolve(url)).rejects.toThrow('Content type is not');
	}
	expect(requests).toEqual(permitted ? [url, alternate] : [url]);
});
