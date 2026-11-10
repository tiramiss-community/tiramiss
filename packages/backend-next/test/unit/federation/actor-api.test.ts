/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { createActivityPubActorApi } from '../../../src/http/activitypub-actor-api.js';

afterEach(() => vi.restoreAllMocks());

test.each(['application/activity+json', 'application/ld+json'])('key lookup failure does not cache the %s error response', async accept => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const app = createActivityPubActorApi({
		readProfile: async () => ({ description: null, followedMessage: null, fields: [], birthday: null, location: null }),
		selfUrl: 'https://local.test',
		isSelfHost: host => host === 'local.test',
		federationEnabled: async () => true,
		readActor: async id => ({ id, username: 'alice', name: null, isBot: false, isLocked: false, isExplorable: true, host: null, uri: null }),
		publicKey: async () => {
			throw new Error('key lookup failed');
		},
	});

	const response = await app.request('/users/local', { headers: { Accept: accept } });

	expect(response.status).toBe(500);
	expect(await response.text()).toBe('Internal Server Error');
	expect(response.headers.get('cache-control')).toBeNull();
	expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
	expect(response.headers.get('vary')).toBe('Accept');
});
