/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Server } from 'node:http';
import { webfingerCorpus as corpus } from '../helpers/webfinger-source.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MiMeta, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { freePort } from '../helpers/process.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let selfUrl: string;
let host: string;
let publicKey: string;
const localId = 'webfinger0001';
const cors = {
	'access-control-allow-headers': 'Accept', 'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-allow-origin': '*', 'access-control-expose-headers': 'Vary',
};
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	const port = await freePort();
	selfUrl = `http://localhost:${port}`;
	host = `localhost:${port}`;
	database.config.url = selfUrl;
	resources = await connectResources(database.config, createLogger('webfinger-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', federation: 'all' });
	await resources.dataSource.getRepository(MiUser).insert([
		{ id: localId, username: 'Alice', usernameLower: 'alice', host: null },
		{ id: 'remote000001', username: 'Alice', usernameLower: 'alice', host: 'remote.test', uri: 'https://remote.test/users/alice' },
		{ id: 'suspended001', username: 'Suspended', usernameLower: 'suspended', isSuspended: true },
		{ id: 'remoteonly01', username: 'RemoteOnly', usernameLower: 'remoteonly', host: 'remote.test' },
		{ id: 'deleted00001', username: 'Deleted', usernameLower: 'deleted', isDeleted: true },
		{ id: 'special00001', username: 'A&&<<>>""\'\'', usernameLower: 'specialchars' },
		{ id: 'cdata0000001', username: 'A]]>B', usernameLower: 'cdata' },
	]);
	const pair = await generateRsaKeyPair();
	publicKey = pair.publicKeyPem;
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: localId });
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: localId, publicKey: publicKey, privateKey: pair.privateKeyPem });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port });
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	await resources?.close();
	await database?.close();
});

function request(resource: string | null, options: RequestInit = {}) {
	return fetch(`${selfUrl}/.well-known/webfinger${resource === null ? '' : `?resource=${encodeURIComponent(resource)}`}`, options);
}

function headers(response: Response, status: number, format: 'jrd' | 'xrd' = 'jrd') {
	expect(response.status).toBe(status);
	for (const [key, value] of Object.entries(cors)) {
		expect(response.headers.get(key), key).toBe(value);
	}
	expect(response.headers.get('vary')).toBe(status === 200 ? 'Accept' : null);
	expect(response.headers.get('cache-control')).toBe(status === 200 ? 'public, max-age=180' : null);
	if (status === 200) {
		expect(response.headers.get('content-type')).toBe(format === 'xrd' ? 'application/xrd+xml' : 'application/jrd+json; charset=utf-8');
	}
}

function expectedDocument(username = 'Alice', id = localId) {
	return {
		subject: `acct:${username}@${host}`,
		links: [
			{ rel: 'self', type: 'application/activity+json', href: `${selfUrl}/users/${id}` },
			{ rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `${selfUrl}/@${username}` },
			{ rel: 'http://ostatus.org/schema/1.0/subscribe', template: `${selfUrl}/authorize-follow?acct={uri}` },
		],
	};
}

test.each([
	'acct', 'bare', 'leading-at', 'bare-host', 'upper', 'profile', 'upper-profile', 'profile-last',
	'actor', 'upper-actor', 'actor-last', 'extra-host', 'empty-host', 'acct-leading-at',
])('ordinary HTTP with real PG discovers local account form %s', async form => {
	const input: Record<string, string> = {
		acct: `acct:alice@${host}`, bare: 'alice', 'leading-at': '@Alice', 'bare-host': `Alice@${host}`,
		upper: `ACCT:ALICE@${host.toUpperCase()}`, profile: `${selfUrl}/@Alice`, 'upper-profile': `${selfUrl.toUpperCase()}/@ALICE`,
		'profile-last': `${selfUrl}/@ignored/Alice`, actor: `${selfUrl}/users/${localId}`, 'upper-actor': `${selfUrl.toUpperCase()}/USERS/${localId.toUpperCase()}`,
		'actor-last': `${selfUrl}/users/ignored/${localId}`, 'extra-host': `alice@${host}@ignored.test`, 'empty-host': 'alice@', 'acct-leading-at': `acct:@Alice@${host}`,
	};
	const response = await request(input[form]);
	headers(response, 200);
	expect(await response.json()).toEqual(expectedDocument());
});

test.each([
	['missing', 400], ['empty', 404], ['empty-acct', 404], ['duplicate', 400], ['brackets', 400], ['foreign-host', 422],
	['missing-port', 422], ['wrong-port', 422], ['foreign-profile', 422], ['foreign-actor', 404], ['missing-user', 404],
	['suspended-name', 404], ['suspended-id', 404], ['remote-only-name', 404], ['remote-id', 404], ['empty-last-id', 404],
] as const)('real PG selection and query parsing reject %s as %s', async (kind, status) => {
	const input: Record<string, string | null> = {
		missing: null, empty: '', 'empty-acct': 'acct:', 'foreign-host': 'alice@foreign.test', 'missing-port': 'alice@localhost',
		'wrong-port': 'alice@localhost:1', 'foreign-profile': 'http://foreign.test/@alice', 'foreign-actor': 'http://foreign.test/users/alice',
		'missing-user': 'nobody', 'suspended-name': 'suspended', 'suspended-id': `${selfUrl}/users/suspended001`,
		'remote-only-name': 'remoteonly', 'remote-id': `${selfUrl}/users/remote000001`, 'empty-last-id': `${selfUrl}/users/${localId}/`,
	};
	const response = kind === 'duplicate' ? await fetch(`${selfUrl}/.well-known/webfinger?resource=alice&resource=alice`)
		: kind === 'brackets' ? await fetch(`${selfUrl}/.well-known/webfinger?resource%5Bx%5D=alice`) : await request(input[kind]);
	headers(response, status);
});

test('a deleted local row remains discoverable without Profile or Key lookups', async () => {
	const response = await request('deleted');
	headers(response, 200);
	expect(await response.json()).toEqual(expectedDocument('Deleted', 'deleted00001'));
});

test('actual WebFinger self href reaches the existing actor GET with the same identity and published key', async () => {
	const discovery = await request(`acct:Alice@${host}`);
	headers(discovery, 200);
	const document = await discovery.json() as { subject: string; links: { rel: string; href: string }[] };
	expect(document.subject).toBe(`acct:Alice@${host}`);
	const self = document.links.find(link => link.rel === 'self')!;
	expect(self.href).toBe(`${selfUrl}/users/${localId}`);
	const response = await fetch(self.href, { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('public, max-age=180');
	expect(await response.json()).toMatchObject({
		id: self.href, preferredUsername: 'Alice',
		publicKey: { id: `${self.href}#main-key`, owner: self.href, publicKeyPem: publicKey },
	});
});

test.each([
	['application/jrd+json', 'jrd'], ['application/xrd+xml', 'xrd'], ['text/html', 'jrd'],
	['application/jrd+json;q=0, application/xrd+xml;q=0', 'jrd'],
	['application/jrd+json;q=0.2, application/xrd+xml;q=0.8', 'xrd'],
	['application/jrd+json;q=0.8, application/xrd+xml;q=0.2', 'jrd'],
	['application/xrd+xml, application/jrd+json', 'xrd'],
] as const)('real HTTP negotiates %s into literal %s', async (accept, format) => {
	const response = await request('alice', { headers: { Accept: accept } });
	headers(response, 200, format);
	if (format === 'jrd') {
		expect(await response.json()).toEqual(expectedDocument());
	} else {
		expect(await response.text()).toBe(corpus.defaults.xrd.replaceAll(corpus.defaults.selfUrl, selfUrl).replace('acct:Alice@local.test:8443', `acct:Alice@${host}`).replace('/users/id', `/users/${localId}`));
	}
});

test.each(['xml-special', 'xml-end-cdata'])('real PG username reaches pinned escaping in %s', async id => {
	const fixture = corpus.cases.find(c => c.id === id);
	const response = await request(id === 'xml-special' ? 'specialchars' : 'cdata', { headers: { Accept: 'application/xrd+xml' } });
	headers(response, 200, 'xrd');
	expect(await response.text()).toBe(fixture!.expected.body!.replaceAll(corpus.defaults.selfUrl, selfUrl).replace('@local.test:8443', `@${host}`).replace('/users/id', `/users/${id === 'xml-special' ? 'special00001' : 'cdata0000001'}`));
});

test.each(['application/jrd+json', 'application/xrd+xml'])('actual HEAD retains %s headers and sends no body', async accept => {
	const response = await request('alice', { method: 'HEAD', headers: { Accept: accept } });
	headers(response, 200, accept === 'application/xrd+xml' ? 'xrd' : 'jrd');
	expect(await response.text()).toBe('');
});

test('stable persisted federation none precedes malformed resource while OPTIONS bypasses it', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
	try {
		for (const resource of [null, '', 'alice@foreign.test', 'alice']) {
			headers(await request(resource), 403);
		}
		const head = await request(null, { method: 'HEAD' });
		headers(head, 403);
		expect(await head.text()).toBe('');
		const options = await request(null, { method: 'OPTIONS' });
		headers(options, 204);
		expect(await options.text()).toBe('');
	} finally {
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	}
});

test('actual User-table fault yields uncached CORS 500, while early rejection performs no User work', async () => {
	// Fault injection is confined to this test-owned DB, never shared roles or permissions.
	await resources.dataSource.query('ALTER TABLE "user" RENAME TO "webfinger_fault_user"');
	try {
		headers(await request('alice'), 500);
		const head = await request('alice', { method: 'HEAD' });
		headers(head, 500);
		expect(await head.text()).toBe('');
		headers(await request(null), 400);
		headers(await request('alice@foreign.test'), 422);
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'none' });
		headers(await request(null), 403);
		headers(await request(null, { method: 'OPTIONS' }), 204);
	} finally {
		await resources.dataSource.query('ALTER TABLE "webfinger_fault_user" RENAME TO "user"');
		await resources.dataSource.getRepository(MiMeta).update('singleton', { federation: 'all' });
	}
	headers(await request('alice'), 200);
});

test('actual Meta-table fault yields uncached CORS 500 while OPTIONS still avoids Meta', async () => {
	await resources.dataSource.query('ALTER TABLE "meta" RENAME TO "webfinger_fault_meta"');
	try {
		headers(await request('alice'), 500);
		headers(await request(null, { method: 'OPTIONS' }), 204);
	} finally {
		await resources.dataSource.query('ALTER TABLE "webfinger_fault_meta" RENAME TO "meta"');
	}
	headers(await request('alice'), 200);
});
