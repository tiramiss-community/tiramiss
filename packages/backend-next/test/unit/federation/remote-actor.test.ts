/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { validateActor, prepareActor, insertActor, collectionVisibility, truncate } from '../../../src/modules/federation/public.js';
import { OutboundStatusError } from '../../../src/application/outbound-http.js';
import { htmlToMfm } from '../../../src/modules/federation/html-to-mfm.js';
import { remoteSource, encode, decode, sourceNow } from '../../helpers/remote-source.js';
import type { RemoteUserFacts } from '../../../src/modules/federation/public.js';

const existing: RemoteUserFacts = { id: 'remote', username: 'Original', host: 'remote.test', uri: 'https://remote.test/users/a', lastFetchedAtMs: null, isDeleted: false, movedToUri: null };
const cases = remoteSource.cases.filter((c: { area: string; }) => c.area === 'actor');
test.each(cases.filter((c: { input: { operation?: string; }; }) => c.input.operation === 'validate'))('$id validates the actual actor against the pinned projection', fixture => {
	const actor = { type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', ...decode(fixture.input.patch) as object };
	if (fixture.expected.error) {
		expect(() => validateActor(actor, 'https://remote.test/request')).toThrow(fixture.expected.error.message);
	} else {
		expect(encode(validateActor(actor, 'https://remote.test/request').actor)).toEqual(fixture.expected.result);
	}
});
test.each(cases.filter((c: { id: string; input: { operation?: string; fail?: string; duplicate?: boolean; deleted?: boolean; }; }) => c.input.operation !== 'validate' && !c.input.fail && !c.input.duplicate && !c.input.deleted))('$id compares actual User/Profile/Key plans to source write projections', async fixture => {
	const input = fixture.input;
	const material = validateActor({ type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', ...decode(input.patch ?? {}) as object }, 'https://remote.test/request');
	const p = material.actor;
	[material.followingVisibility, material.followersVisibility] = await Promise.all([p.following, p.followers].map(value => collectionVisibility(value, async v => {
		if (input.collectionFail) {
			throw new OutboundStatusError('collection unavailable', input.collectionFail);
		}
		return v as Record<string, unknown>;
	}, input.operation === 'refresh')));
	// The source's explicit conversion double is applied only at this material boundary.
	material.description = p._misskey_summary ? truncate(p._misskey_summary, 2048) : p.summary ? `converted:${truncate(p.summary, 2048)}` : null;
	material.fields = Array.isArray(p.attachment) ? p.attachment.filter(f => f.type === 'PropertyValue').map(f => ({ name: f.name, value: `field:${f.value}` })) : [];
	if (fixture.expected.error) {
		await expect(prepareActor(material, input.operation === 'refresh' ? existing : null, sourceNow, 'new-user')).rejects.toThrow(fixture.expected.error.message); return;
	}
	const plan = await prepareActor(material, input.operation === 'refresh' ? existing : null, sourceNow, 'new-user');
	const userEvent = fixture.expected.events.find((e: { op: string; }) => e.op === (input.operation === 'refresh' ? 'User.update' : 'User.save'));
	const profileEvent = fixture.expected.events.find((e: { op: string; }) => e.op === (input.operation === 'refresh' ? 'Profile.update' : 'Profile.save'));
	const user = { ...plan.user };
	// Source fixture supplies resolveAvatarAndBanner={} (no media projection).
	if (input.operation === 'refresh') {
		for (const key of ['avatarId', 'avatarUrl', 'avatarBlurhash', 'bannerId', 'bannerUrl', 'bannerBlurhash']) {
			delete user[key as keyof typeof user];
		}
	}
	expect(encode(user)).toEqual(userEvent.args.patch ?? userEvent.args);
	expect(encode(plan.profile)).toEqual(profileEvent.args.patch ?? profileEvent.args);
	const keyEvent = fixture.expected.events.find((e: { op: string; }) => e.op === (input.operation === 'refresh' ? 'Key.update' : 'Key.save'));
	expect(encode(plan.publickey)).toEqual(keyEvent ? keyEvent.args.patch ?? keyEvent.args : { $undefined: true });
	if (input.operation !== 'refresh') {
		const writes: unknown[] = [];
		await insertActor({
			insertUser: async v => {
				writes.push(encode(v));
			}, insertProfile: async v => {
				writes.push(encode(v));
			}, insertPublickey: async v => {
				writes.push(encode(v));
			}
		}, plan);
		expect(writes).toEqual(fixture.expected.events.filter((e: { op: string; }) => e.op.endsWith('.save')).map((e: { args: unknown; }) => e.args));
	}
});
test('real pinned-parser HTML conversion preserves formatting, mentions, links and paragraphs without fixture tags', () => {
	expect(htmlToMfm('<p>Hello <b>world</b><br><a href="https://remote.test/@a">@a</a></p><p><a href="https://remote.test">site</a></p>')).toBe('Hello **world**\n@a@remote.test\n\n[site](https://remote.test)');
});

for (const fixture of cases.filter((c: { input: { operation?: string; }; }) => c.input.operation === 'refresh')) {
	test(`${fixture.id} preserves source ordered update attempts and partial failures in the actual refresher`, async () => {
		const { createActorRefresher } = await import('../../../src/modules/federation/public.js');
		const material = validateActor({ type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', ...decode(fixture.input.patch ?? {}) as object }, 'https://remote.test/request');
		const p = material.actor;
		[material.followingVisibility, material.followersVisibility] = await Promise.all([p.following, p.followers].map(value => collectionVisibility(value, async v => {
			if (fixture.input.collectionFail) {
				throw new OutboundStatusError('collection unavailable', fixture.input.collectionFail);
			}
			return v as Record<string, unknown>;
		}, true)));
		material.description = p._misskey_summary ? truncate(p._misskey_summary, 2048) : p.summary ? `converted:${truncate(p.summary, 2048)}` : null;
		material.fields = Array.isArray(p.attachment) ? p.attachment.filter(f => f.type === 'PropertyValue').map(f => ({ name: f.name, value: `field:${f.value}` })) : [];
		const events: { op: string; args: unknown; }[] = [];

		async function update(name: string, query: unknown, patch: unknown) {
			events.push({ op: `${name}.update`, args: { query, patch } });
			if (fixture.input.fail === name) {
				throw new Error(`${name} write failed`);
			}
		}

		const refresh = createActorRefresher({
			async updateUser(id, user) {
				const projection = { ...user };
				for (const key of ['avatarId', 'avatarUrl', 'avatarBlurhash', 'bannerId', 'bannerUrl', 'bannerBlurhash']) {
					delete projection[key as keyof typeof projection];
				}
				await update('User', { id, isDeleted: false }, projection); return !fixture.input.deleted;
			},
			updatePublickey: (id, key) => update('Key', { userId: id }, key),
			updateProfile: (id, profile) => update('Profile', { userId: id }, profile),
			updateFollowing: (id, sharedInbox) => update('Following', { followerId: id }, { followerSharedInbox: sharedInbox }),
		});
		try {
			const plan = await prepareActor(material, existing, sourceNow, 'unused');
			await refresh(existing.id, plan);
			expect(fixture.expected.error).toBeUndefined();
		} catch (error) {
			if (!fixture.expected.error) {
				throw error;
			}
			expect((error as Error).message).toBe(fixture.expected.error.message);
		}
		expect(encode(events)).toEqual(fixture.expected.events);
	});
}
test('actor-create-profile-failure: actual insertion attempts User then Profile, and propagates failure for caller rollback', async () => {
	const fixture = cases.find((c: { id: string; }) => c.id === 'actor-create-profile-failure')!;
	const material = validateActor({ type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox' }, 'https://remote.test/request');
	material.followingVisibility = material.followersVisibility = 'private';
	const plan = await prepareActor(material, null, sourceNow, 'new-user');
	const events: { op: string; args?: unknown; }[] = [{ op: 'transaction.begin' }];
	try {
		await insertActor({
			insertUser: async user => {
				events.push({ op: 'User.save', args: user });
			}, insertProfile: async profile => {
				events.push({ op: 'Profile.save', args: profile }); throw new Error('Profile write failed');
			}, insertPublickey: async () => {
				throw new Error('unexpected Key write');
			}
		}, plan);
	} catch (error) {
		events.push({ op: 'transaction.rollback' }); expect((error as Error).message).toBe(fixture.expected.error.message);
	}
	expect(encode(events)).toEqual(fixture.expected.events);
});
test('description failure is delayed until after the User/Key commits on refresh and after User insertion on create', async () => {
	const material = validateActor({ type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', publicKey: { id: 'https://remote.test/users/a#key', publicKeyPem: 'key' } }, 'https://remote.test/users/a');
	material.profileError = { name: 'TypeError', message: 'Invalid URL' };
	const { createActorRefresher } = await import('../../../src/modules/federation/public.js');
	const events: string[] = [];
	const refresher = createActorRefresher({
		updateUser: async () => {
			events.push('User'); return true;
		}, updatePublickey: async () => {
			events.push('Key');
		}, updateProfile: async () => {
			events.push('Profile');
		}, updateFollowing: async () => {
			events.push('Following');
		}
	});
	await expect(refresher('remote', await prepareActor(material, existing, sourceNow, 'unused'))).rejects.toThrow('Invalid URL');
	expect(events).toEqual(['User', 'Key']);
	events.length = 0;
	await expect(insertActor({
		insertUser: async () => {
			events.push('User');
		}, insertProfile: async () => {
			events.push('Profile');
		}, insertPublickey: async () => {
			events.push('Key');
		}
	}, await prepareActor(material, null, sourceNow, 'new-user'))).rejects.toThrow('Invalid URL');
	expect(events).toEqual(['User']);
});

test.each([undefined, null, [], { url: null }, {}].map(icon => ({ icon })))('explicit absent media $icon clears supported core fields without claiming image acquisition', async ({ icon }) => {
	const material = validateActor({ type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', icon, image: icon }, 'https://remote.test/users/a');
	const plan = await prepareActor(material, existing, sourceNow, 'unused');
	expect(plan.user).toMatchObject({ avatarId: null, avatarUrl: null, avatarBlurhash: null, bannerId: null, bannerUrl: null, bannerBlurhash: null });
});
