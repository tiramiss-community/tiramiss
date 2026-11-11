/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { webfingerCorpus as corpus, webfingerSource as observations } from '../../helpers/webfinger-source.js';
import { createWebfingerApi } from '../../../src/http/webfinger-api.js';
import type { LocalWebfingerQuery } from '../../../src/modules/federation/public.js';

test.each(corpus.cases)('$id directly matches pinned createServer HTTP and lookup observations', async c => {
	const expected = observations.cases.find(row => row.id === c.id)!;
	expect(expected).toBeDefined();
	const user = { ...corpus.defaults.row, ...c.row };
	const readUser = vi.fn(async (query: LocalWebfingerQuery) => {
		if (c.fail) {
			throw Error('database unavailable');
		}
		if (user.host !== null || user.isSuspended) {
			return null;
		}
		return ('id' in query ? query.id === user.id : query.usernameLower === 'alice') ? { id: user.id, username: user.username } : null;
	});
	const federationEnabled = vi.fn(async () => {
		if (c.metaFail) {
			throw Error('meta unavailable');
		}
		return c.federation !== 'none';
	});
	const app = createWebfingerApi({ selfUrl: corpus.defaults.selfUrl, readUser, federationEnabled });
	const query = c.queryString ?? (c.resource === null ? '' : `resource=${encodeURIComponent(c.resource)}`);
	const response = await app.request(`/.well-known/webfinger?${query}`, { method: c.method ?? 'GET', headers: c.accept ? { Accept: c.accept } : {} });
	expect(response.status).toBe(expected.status);
	// Lookup arguments and absence of calls protect both resource projection and early exits.
	expect(readUser.mock.calls.map(([value]) => value)).toEqual(expected.lookups);
	expect(federationEnabled).toHaveBeenCalledTimes(c.method === 'OPTIONS' ? 0 : 1);
	for (const [key, value] of Object.entries(expected.headers)) {
		// Non-success diagnostic bodies/content types are outside the source comparison contract.
		if (key !== 'content-type' || expected.status === 200) {
			expect(response.headers.get(key), key).toBe(value);
		}
	}
	if (expected.status === 200) {
		expect(c.method === 'HEAD' ? await response.text() : c.expected.format === 'jrd' ? await response.json() : await response.text()).toEqual(expected.body);
	} else if (c.method === 'HEAD' || c.method === 'OPTIONS') {
		expect(await response.text()).toBe('');
	}
});

test('a Meta read failure returns uncached discovery 500 with CORS before any user lookup', async () => {
	const readUser = vi.fn(async () => null);
	const app = createWebfingerApi({ selfUrl: corpus.defaults.selfUrl, readUser, federationEnabled: async () => {
		throw Error('meta read unavailable');
	} });
	const response = await app.request('/.well-known/webfinger');
	expect(response.status).toBe(500);
	expect(response.headers.get('access-control-allow-origin')).toBe('*');
	expect(response.headers.get('access-control-allow-headers')).toBe('Accept');
	expect(response.headers.get('cache-control')).toBeNull();
	expect(response.headers.get('vary')).toBeNull();
	expect(readUser).not.toHaveBeenCalled();
});
