/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { emptyActorFields, emptyActorMedia } from '../../helpers/local-actor.js';
import { afterEach, expect, test, vi } from 'vitest';
import { createActivityPubActorApi } from '../../../src/http/activitypub-actor-api.js';

afterEach(() => vi.restoreAllMocks());

test.each(['application/activity+json', 'application/ld+json'])('key lookup failure does not cache the %s error response', async accept => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const app = createActivityPubActorApi({
		readTags: async () => [],
		readMaterials: async () => ({ profile: { description: null, followedMessage: null, fields: [], birthday: null, location: null }, media: emptyActorMedia }),
		selfUrl: 'https://local.test',
		isSelfHost: host => host === 'local.test',
		federationEnabled: async () => true,
		readActor: async id => ({ ...emptyActorFields, id, avatarId: null, bannerId: null, username: 'alice', name: null, isBot: false, isLocked: false, isExplorable: true, emojis: [], tags: [], host: null, uri: null }),
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

// Moving materials ahead of any rejection/redirect would turn these statuses into errors.
test.each([
	{ kind: 'html', status: 404 }, { kind: 'unacceptable', status: 404 }, { kind: 'disabled', status: 403 },
	{ kind: 'missing', status: 404 }, { kind: 'remote', status: 301 }, { kind: 'remote-without-uri', status: 500 }, { kind: 'remote-self-host', status: 500 },
])('$kind bypasses image/profile acquisition', async ({ kind, status }) => {
	let materialsRead = false;
	const app = createActivityPubActorApi({ selfUrl: 'https://local.test', isSelfHost: host => host === 'local.test', federationEnabled: async () => kind !== 'disabled',
		readActor: async () => kind === 'missing' ? null : { ...emptyActorFields, id: 'local', avatarId: 'avatar', bannerId: 'banner', username: 'alice', name: null, isBot: false, isLocked: false, isExplorable: true, emojis: [], tags: [], host: kind === 'remote-self-host' ? 'local.test' : kind.startsWith('remote') ? 'remote.test' : null, uri: kind === 'remote-without-uri' ? null : 'https://remote.test/actor' },
		readMaterials: async () => {
			materialsRead = true; throw Error('must not acquire media');
		}, readTags: async () => {
			throw Error('must not acquire tags');
		}, publicKey: async () => {
			throw Error('must not acquire key');
		},
	});
	const response = await app.request('/users/local', { headers: { Accept: kind === 'html' ? 'text/html' : kind === 'unacceptable' ? 'image/png' : 'application/activity+json' } });
	expect(response.status).toBe(status);
	expect(materialsRead).toBe(false);
	expect(response.headers.get('cache-control')).toBeNull();
	if (kind === 'remote') {
		expect(response.headers.get('location')).toBe('https://remote.test/actor');
	}
});
