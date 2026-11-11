/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { MiMeta } from 'backend-upstream/entities';
import { createRemoteUsers } from '../../../src/composition/remote-users.js';
import { createDataSource } from '../../../src/platform/database/data-source.js';
import { testConfig } from '../../helpers/database.js';
import { htmlToMfm, insertActor, createActorRefresher } from '../../../src/modules/federation/public.js';
import { decode } from '../../helpers/remote-source.js';
import type { RemoteUserFacts } from '../../../src/modules/federation/public.js';

afterEach(() => vi.restoreAllMocks());
const existing: RemoteUserFacts = { id: 'remote', username: 'Original', host: 'entry.test', uri: 'https://remote.test/users/a', lastFetchedAtMs: 0, isDeleted: false, tags: [], movedToUri: null };
const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/remote-user/remote-profile-observations.json', import.meta.url), 'utf8')) as { cases: { id: string; area: string; input: any; expected: any }[] };

// Meta and HTTP supply external material. Real validation, conversion and acquisition run.
function acquisition(patch: Record<string, unknown> = {}) {
	const events: string[] = [];
	const requests: string[] = [];
	const config = testConfig(); config.url = 'https://local.test';
	const dataSource = createDataSource(config.database);
	vi.spyOn(dataSource.getRepository(MiMeta), 'find').mockResolvedValue([Object.assign(new MiMeta(), { federation: 'all', signToActivityPubGet: false, blockedHosts: [], federationHosts: [], silencedHosts: [], mediaSilencedHosts: [], deliverSuspendedSoftware: [] })]);
	const ports = createRemoteUsers({
		logger: { info() { }, error() { } }, dataSource, userHashtags: { start() { } }, actorInstanceRegistration: { start() { } },
		remoteEmojis: {
			async extract(_tags, host) {
				events.push('extract:' + host); return [];
			},
		},
		outboundHttp: {
			async send(url: string) {
				requests.push(url);
				if (url === 'https://remote.test/users/a/following' || url === 'https://remote.test/users/a/followers') {
					return { finalUrl: url, header: () => 'application/activity+json', json: async () => ({ '@context': 'https://www.w3.org/ns/activitystreams', id: url, type: 'OrderedCollection', totalItems: 0 }) };
				}
				events.push('actor');
				const body = { type: 'Person', id: existing.uri, preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', tag: [], ...patch };
				return { finalUrl: url, header: () => 'application/activity+json', json: async () => ({ '@context': 'https://www.w3.org/ns/activitystreams', ...body }) };
			},
		} as never, federationKeys: undefined as never,
	}, config);
	return { ports, events, requests };
}

test.each([false, true])('attachment selection fails before conversion of an earlier invalid URL (refresh=%s)', async refresh => {
	const h = acquisition({ following: 'https://remote.test/users/a/following', followers: 'https://remote.test/users/a/followers', attachment: [{ type: 'PropertyValue', name: 'site', value: '<a href="not-a-url">@a</a>' }, null] });
	await expect(h.ports.acquireActor(existing.uri!, refresh ? existing : null, Date.now, () => 'new-user')).rejects.toThrow("Cannot read properties of null (reading 'type')");
	expect(h.events).toEqual(refresh ? ['actor', 'extract:entry.test'] : ['actor']);
	expect(h.requests).toEqual([existing.uri]);
});

// Reverting filter-before-map changes the priority regression; changing real conversion,
// truncation or summary/tag plumbing changes these independent source projections.
test.each(source.cases.filter(c => c.area === 'html'))('$id real HTML conversion matches pinned fromHtml', fixture => {
	const input = decode(fixture.input) as any;
	if (fixture.expected.error) {
		expect(() => htmlToMfm(input.html, input.hashtagNames)).toThrow(fixture.expected.error.message);
	} else {
		expect(htmlToMfm(input.html, input.hashtagNames)).toBe(fixture.expected.result);
	}
});

test.each(source.cases.filter(c => c.area === 'attachment'))('$id actual acquisition matches analyzeAttachments', async fixture => {
	const input = decode(fixture.input) as any;
	const h = acquisition({ attachment: input.attachment });
	const plan = await h.ports.acquireActor(existing.uri!, null, () => 1800000000000, () => 'new-user');
	expect(plan.profile.fields).toEqual(fixture.expected.result);
});

test.each(source.cases.filter(c => c.area === 'create' || c.area === 'refresh').filter(c => c.id !== 'create-canonical'))('$id acquisition and write boundary match literal source', async fixture => {
	const input = decode(fixture.input) as any;
	const h = acquisition(input.patch);
	const refresh = fixture.area === 'refresh';
	const operations: string[] = [];
	let actualError;
	let plan;
	try {
		plan = await h.ports.acquireActor(existing.uri!, refresh ? existing : null, () => 1800000000000, () => 'new-user');
		const write = async (kind: string) => {
			operations.push(kind);
			if (input.fail === kind.split('.')[0]) {
				throw Error(`${input.fail} failed`);
			}
		};
		if (refresh) {
			await createActorRefresher({
				async updateUser() {
					await write('User.update'); return true;
				},
				async updatePublickey() {
					await write('Key.update');
				},
				async updateProfile() {
					await write('Profile.update');
				},
				async updateFollowing() {
					await write('Following.update');
				},
			}, () => {
				operations.push('hashtags');
			})(existing.id, plan);
		} else {
			await insertActor({
				async insertUser() {
					await write('User.save');
				},
				async insertProfile() {
					await write('Profile.save');
				},
				async insertPublickey() {
					await write('Key.save');
				},
			}, plan);
		}
	} catch (error) {
		actualError = error as Error;
	}
	if (fixture.expected.error) {
		expect(actualError).toMatchObject(fixture.expected.error);
	} else {
		expect(actualError).toBeUndefined();
	}
	const profile = fixture.expected.events.find((e: any) => e.op === (refresh ? 'Profile.update' : 'Profile.save'))?.args;
	if (profile) {
		expect(plan?.profile.description).toBe(profile.description);
		expect(plan?.profile.fields).toEqual(profile.fields);
	}
	// The source's post-create media update is outside the profile write projection.
	const sourceOps = fixture.expected.events.map((e: any) => e.op).filter((op: string) =>
		refresh ? /^(User|Key|Profile|Following)\.update$/.test(op) || op === 'hashtags' : /^(User|Key|Profile)\.save$/.test(op));
	expect(operations).toEqual(sourceOps);
});
