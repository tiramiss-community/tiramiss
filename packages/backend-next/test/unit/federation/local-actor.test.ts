/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { emptyActorMedia } from '../../helpers/local-actor.js';
import { expect, test } from 'vitest';
import { renderLocalActor } from '../../../src/modules/federation/public.js';
const emptyProfile = { description: null, followedMessage: null, fields: [], birthday: null, location: null };

// Historical publication oracle excludes tags/images; additive corpora cover them.
function identity(body: Record<string, unknown>) {
	const { summary, _misskey_summary, _misskey_followedMessage, attachment, tag, icon, image, ...rest } = body;
	return rest;
}

import { remoteSource } from '../../helpers/remote-source.js';

test.each(remoteSource.cases.filter((c: { id: string; }) => ['publication-local', 'publication-system', 'publication-bot', 'publication-deleted'].includes(c.id)))('$id renders the consumed source signer projection with an actual context', fixture => {
	const expected = fixture.expected.result;
	const rendered = renderLocalActor({ id: 'local', avatarId: null, bannerId: null, username: fixture.input.system ? 'instance.actor' : 'alice', name: null, isBot: fixture.input.bot ?? false, isLocked: true, isExplorable: false, emojis: [], tags: [] }, emptyProfile, 'https://local.test', expected.publicKey.publicKeyPem, [], emptyActorMedia);
	const { '@context': context, ...projection } = rendered;
	expect(Array.isArray(context)).toBe(true);
	expect(context).toContain('https://www.w3.org/ns/activitystreams');
	expect(identity(projection)).toEqual(expected);
});

for (const fixture of remoteSource.cases.filter(c => c.area === 'publication')) {
	test(`${fixture.id} executes the actual HTTP adapter including Accept quality and source query ordering`, async () => {
		const { createActivityPubActorApi } = await import('../../../src/http/activitypub-actor-api.js');
		const calls: unknown[] = [];
		const keyFixture = remoteSource.cases.find(c => c.id === 'publication-local')!;
		const app = createActivityPubActorApi({
			selfUrl: 'https://local.test',
			readTags: async () => [],
			readMaterials: async () => ({ profile: emptyProfile, media: emptyActorMedia }),
			isSelfHost: host => host === 'local.test', federationEnabled: async () => fixture.input.federation !== 'none',
			publicKey: async () => keyFixture.expected.result.publicKey.publicKeyPem,
			readActor: async id => {
				calls.push({ id, isSuspended: false });
				return fixture.input.missing || fixture.input.user?.isSuspended ? null : { id, avatarId: null, bannerId: null, username: fixture.input.system ? 'instance.actor' : 'alice', name: null, isBot: fixture.input.bot ?? false, isLocked: true, isExplorable: false, emojis: [], tags: [], host: null, uri: null, ...fixture.input.user };
			},
		});
		const response = await app.request('/users/local', { headers: { Accept: fixture.input.accept ?? 'application/activity+json' } });
		const sourceEvents = fixture.expected.events;
		expect(calls).toEqual(sourceEvents.filter((e: { op: string; }) => e.op === 'User.find').map((e: { args: unknown; }) => e.args));
		if (fixture.expected.result?.fallthrough) {
			expect(response.status).toBe(404); return;
		}
		expect(response.headers.get('vary')).toBe('Accept');
		const status = sourceEvents.find((e: { op: string; }) => e.op === 'status');
		if (status) {
			expect(response.status).toBe(status.args); return;
		}
		const redirect = sourceEvents.find((e: { op: string; }) => e.op === 'redirect');
		if (redirect) {
			expect(response.status).toBe(redirect.args.status); expect(response.headers.get('location')).toBe(redirect.args.uri); return;
		}
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=180');
		expect(response.headers.get('content-type')).toBe(sourceEvents.find((e: { op: string; }) => e.op === 'type').args);
		const { '@context': _context, ...result } = await response.json();
		expect(identity(result)).toEqual(fixture.expected.result);
	});
}
