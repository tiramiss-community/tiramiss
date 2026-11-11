/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { renderLocalActor } from '../../../src/modules/federation/public.js';
import { createActivityPubActorApi } from '../../../src/http/activitypub-actor-api.js';
import type { LocalActorProfileFacts } from '../../../src/modules/federation/public.js';
const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/remote-user/local-actor-profile-observations.json', import.meta.url), 'utf8'));
const empty: LocalActorProfileFacts = { description: null, followedMessage: null, fields: [], birthday: null, location: null };
const user = { id: 'local', username: 'alice', name: null, isBot: false, isLocked: true, isExplorable: false, emojis: [], tags: [], host: null, uri: null };
const keys = ['name', 'summary', '_misskey_summary', '_misskey_followedMessage', 'attachment', 'vcard:bday', 'vcard:Address'];
// Removing any projected property, changing URL serialization, or swallowing MFM errors breaks these source-derived outcomes.
for (const c of source.cases.filter((c: { fail?: string; }) => !c.fail)) {
	test(`profile ${c.id} matches independent real source raw and JSON projection`, () => {
		const render = () => renderLocalActor({ ...user, name: c.name ?? null }, c.profile, 'https://local.test', 'key', []);
		if (c.expected.error) {
			expect(render).toThrow(c.expected.error.message);
			return;
		}
		const body = render();
		const projection = Object.fromEntries(keys.filter(k => Object.hasOwn(body, k)).map(k => [k, body[k]]));
		const raw = Object.fromEntries(Object.entries(projection).map(([k, v]) => [k, v === undefined ? { $undefined: true } : v]));
		expect(raw).toEqual(c.expected.raw);
		expect(JSON.parse(JSON.stringify(projection))).toEqual(c.expected.json);
	});
}
// Moving the required Profile lookup ahead of the HTTP checks breaks these observable statuses.
test.each(['disabled', 'missing', 'remote'])('HTTP %s does not read required Profile', async kind => {
	const app = createActivityPubActorApi({ readTags: async () => [], selfUrl: 'https://local.test', federationEnabled: async () => kind !== 'disabled', isSelfHost: () => false,
																																									readActor: async () => kind === 'missing' ? null : { ...user, host: kind === 'remote' ? 'remote.test' : null, uri: 'https://remote.test/user' },
																																									readProfile: async () => {
																																										throw Error('must not read Profile');
																																									}, publicKey: async () => {
																																										throw Error('must not read key');
																																									} });
	const response = await app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	expect(response.status).toBe(kind === 'disabled' ? 403 : kind === 'missing' ? 404 : 301);
});
test.each(['missing Profile', 'database unavailable', 'MFM'])('HTTP surfaces %s instead of publishing empty facts', async kind => {
	const app = createActivityPubActorApi({ readTags: async () => [], selfUrl: 'https://local.test', federationEnabled: async () => true, isSelfHost: () => false, readActor: async () => user,
																																									readProfile: async () => {
																																										if (kind !== 'MFM') {
																																											throw Error(kind);
																																										}
																																										return { ...empty, description: '$[ruby single]' };
																																									}, publicKey: async () => 'key' });
	app.onError(() => new Response('failed', { status: 500 }));
	expect((await app.request('/users/local', { headers: { Accept: 'application/activity+json' } })).status).toBe(500);
});
test('HTTP publishes profile with name and source raw summary', async () => {
	const calls: string[] = [];
	let releaseProfile!: () => void;
	let profileStarted!: () => void;
	const started = new Promise<void>(resolve => {
		profileStarted = resolve;
	});
	const gate = new Promise<void>(resolve => {
		releaseProfile = resolve;
	});
	const app = createActivityPubActorApi({ readTags: async () => [],
		selfUrl: 'https://local.test', federationEnabled: async () => true, isSelfHost: () => false, readActor: async () => ({ ...user, name: 'Alice' }),
		readProfile: async () => {
			calls.push('profile start');
			profileStarted();
			await gate;
			calls.push('profile complete');
			return { ...empty, get description() {
				calls.push('render');
				return '**bold**';
			}, followedMessage: '', location: 'Tokyo' };
		},
		publicKey: async () => {
			calls.push('key');
			return 'key';
		},
	});
	const pending = app.request('/users/local', { headers: { Accept: 'application/activity+json' } });
	await started;
	const beforeCompletion = [...calls];
	releaseProfile();
	const response = await pending;
	expect(beforeCompletion).toEqual(['profile start']);
	expect(calls.indexOf('profile complete')).toBeLessThan(calls.indexOf('key'));
	expect(calls.indexOf('key')).toBeLessThan(calls.indexOf('render'));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ name: 'Alice', summary: '<b>bold</b>', _misskey_summary: '**bold**', _misskey_followedMessage: '', 'vcard:Address': 'Tokyo' });
});
