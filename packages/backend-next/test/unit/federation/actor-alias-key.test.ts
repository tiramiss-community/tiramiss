/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createActivityPubActorAliasKeyApi } from '../../../src/http/activitypub-actor-api.js';
import { createHostRules } from '../../../src/modules/federation/host.js';
import { emptyActorFields, emptyActorMedia } from '../../helpers/local-actor.js';

function fixture() {
	const user = { ...emptyActorFields, id: 'local', username: 'Alice', name: null, avatarId: null, bannerId: null, isBot: false, isLocked: false, isExplorable: true, emojis: [], tags: [], host: null as string | null, uri: null as string | null };
	const parts = {
		selfUrl: 'https://local.test', production: true,
		isSelfHost: createHostRules('local.test').isSelfHost,
		federationEnabled: vi.fn(async () => true), allowExternalApRedirect: vi.fn(async () => true),
		readActor: vi.fn(async () => user), readActorByAcct: vi.fn(async () => user), readKeyOwner: vi.fn(async () => ({ id: user.id })),
		readMaterials: vi.fn(async () => ({ profile: { description: null, followedMessage: null, fields: [], birthday: null, location: null }, media: emptyActorMedia })),
		readPublicKey: vi.fn(async () => 'spki'), toSpki: (pem: string) => pem,
		readTags: vi.fn(async () => []), publicKey: vi.fn(async () => 'spki'),
	};
	return { user, parts, app: createActivityPubActorAliasKeyApi(parts) };
}

test('acct alias publishes the existing actor and lowercases only username', async () => {
	const { app, parts } = fixture();
	const response = await app.request('/@ALIce@REMOTE.test', { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(await (await app.request('/users/local', { headers: { Accept: 'application/activity+json' } })).json());
	expect(parts.readActorByAcct).toHaveBeenCalledWith({ username: 'alice', host: 'REMOTE.test' });
});
test.each(['text/html', 'application/json', 'application/ld+json', 'application/activity+json'])('standalone public key supports %s without actor materials', async accept => {
	const { app, parts } = fixture();
	const response = await app.request('/users/local/publickey', { headers: { Accept: accept } });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ type: 'Key', id: 'https://local.test/users/local/publickey', owner: 'https://local.test/users/local', publicKeyPem: 'spki' });
	expect(response.headers.get('vary')).toBeNull();
	expect(response.headers.get('cache-control')).toBe('public, max-age=180');
	expect(parts.readMaterials).not.toHaveBeenCalled();
	expect(parts.readTags).not.toHaveBeenCalled();
});
test('remote alias guard refuses external AP redirects', async () => {
	const { app, user, parts } = fixture();
	user.host = 'remote.test'; user.uri = 'https://remote.test/actor'; parts.allowExternalApRedirect.mockResolvedValue(false);
	const response = await app.request('/@alice@remote.test', { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(406);
	expect(response.headers.get('location')).toBeNull();
	expect(response.headers.get('link')).toBe('<https://remote.test/actor>; rel="canonical"');
	expect(await response.text()).toContain('Refusing to relay remote ActivityPub object lookup.');
	expect(parts.publicKey).not.toHaveBeenCalled();
});

import { readFileSync } from 'node:fs';
import { toSpkiPublicKeyPem } from '../../../src/modules/federation/keys.js';
import { parseAcct, formatAcct, renderLocalKey } from '../../../src/modules/federation/public.js';
const evidenceRoot = new URL('../../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('local-actor-alias-key-corpus.json', evidenceRoot), 'utf8')) as { cases: Array<{ id: string; path: string; method?: string; accept?: string; kind?: string; selfUrl?: string; federation?: string; allow?: boolean; production?: boolean; uri?: string }> };
const observed = JSON.parse(readFileSync(new URL('local-actor-alias-key-observations.json', evidenceRoot), 'utf8'));
const keys = JSON.parse(readFileSync(new URL('local-actor-alias-key-key.json', evidenceRoot), 'utf8'));

test.each(corpus.cases)('$id consumes the independent pinned route observation', async row => {
	const expected = observed.cases.find((x: { id: string }) => x.id === row.id);
	const { parts, user } = fixture();
	parts.selfUrl = row.selfUrl ?? parts.selfUrl; parts.production = row.production ?? true;
	parts.isSelfHost = createHostRules(new URL(parts.selfUrl).host).isSelfHost;
	parts.federationEnabled.mockResolvedValue(row.federation !== 'none'); parts.allowExternalApRedirect.mockResolvedValue(row.allow ?? true);
	user.host = row.kind === 'remote' || /remote.test/i.test(row.path) ? 'remote.test' : null;
	user.uri = row.uri ?? 'https://remote.test/actor';
	if (['null-uri', 'empty-uri', 'self-row'].includes(row.kind ?? '')) {
		user.host = row.kind === 'self-row' ? 'local.test' : 'remote.test'; user.uri = row.kind === 'null-uri' ? null : row.kind === 'empty-uri' ? '' : user.uri;
	}
	// The source probe deliberately supplies arbitrary rows to observe predicates independently of storage.
	parts.readActorByAcct = vi.fn(async () => row.kind === 'missing' || row.kind === 'suspended' ? null : user) as typeof parts.readActorByAcct;
	parts.readKeyOwner = vi.fn(async (id: string) => row.kind === 'missing' || id !== 'local' || user.host !== null ? null : { id }) as typeof parts.readKeyOwner;
	parts.publicKey.mockImplementation(async () => {
		if (row.kind === 'key-missing') {
			throw Error('missing key');
		}
		return toSpkiPublicKeyPem(row.kind === 'key-invalid' ? 'invalid' : keys.pkcs1);
	});
	parts.readPublicKey.mockImplementation(async () => {
		if (row.kind === 'key-missing') {
			throw Error('missing key');
		}
		return row.kind === 'key-invalid' ? 'invalid' : keys.pkcs1;
	});
	parts.toSpki = toSpkiPublicKeyPem;
	const app = createActivityPubActorAliasKeyApi(parts);
	const response = await app.request(row.path, { method: row.method, headers: row.accept === '' ? {} : { Accept: row.accept ?? 'application/activity+json' } });
	expect(response.status).toBe(expected.status);
	if (expected.status === 414) {
		expect(parts.federationEnabled).not.toHaveBeenCalled();
	}
	// HTML/nonmatching route fallback is owned by #196, not the AP plugin.
	if (expected.status === 404 && expected.calls.length === 0) {
		expect(parts.readActorByAcct).not.toHaveBeenCalled(); return;
	}
	for (const [name, value] of Object.entries(expected.headers)) {
		expect(response.headers.get(name), name).toBe(value);
	}
	const body = await response.text();
	if (response.status === 200) {
		const json = JSON.parse(body); const source = JSON.parse(expected.body);
		if (row.path.startsWith('/@')) {
			expect({ '@context': json['@context'], type: json.type, id: json.id, publicKey: json.publicKey }).toEqual(source);
		} else {
			expect(json).toEqual(source);
		}
	} else if (body && response.headers.get('content-type')?.startsWith('application/json')) {
		const json = JSON.parse(body); expect({ statusCode: json.statusCode, error: json.error }).toEqual(JSON.parse(expected.body));
	} else {
		expect(body).toBe(row.method === 'HEAD' ? '' : expected.body);
	}
	const lookup = expected.calls.find((x: unknown[]) => x[0] === 'lookup')?.[1];
	if (lookup && 'usernameLower' in lookup) {
		expect(parts.readActorByAcct).toHaveBeenCalledExactlyOnceWith({ username: lookup.usernameLower, host: lookup.host });
	} else if (lookup) {
		expect(parts.readKeyOwner).toHaveBeenCalledExactlyOnceWith(lookup.id);
	} else {
		expect(parts.readActorByAcct).not.toHaveBeenCalled(); expect(parts.readKeyOwner).not.toHaveBeenCalled();
	}
	if (!expected.calls.some((x: unknown[]) => x[0] === 'key')) {
		expect(parts.publicKey).not.toHaveBeenCalled(); expect(parts.readPublicKey).not.toHaveBeenCalled();
	}
});

test('pure acct and key helpers consume fixed-source observations', () => {
	for (const row of observed.acct) {
		expect(parseAcct(row.input)).toEqual(row.parsed); expect(formatAcct(row.parsed)).toBe(row.formatted);
	}
	for (const row of observed.key) {
		expect(renderLocalKey('local', 'https://local.test', toSpkiPublicKeyPem(keys.pkcs1), row.postfix ?? undefined)).toEqual(row.output);
	}
	expect(formatAcct({ username: 'alice', host: undefined as unknown as null })).toBe('alice');
	expect(() => toSpkiPublicKeyPem('invalid')).toThrow();
});
