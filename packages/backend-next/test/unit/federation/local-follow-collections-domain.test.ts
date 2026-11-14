/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { readFollowCollection } from '../../../src/modules/federation/local-follow-collections.js';
import { followCorpus, followFixture, followSource } from '../../helpers/local-follow-collections.js';

for (const direction of ['followers', 'following'] as const) {
	for (const page of [false, true]) {
		test(`${direction} domain returns collection data for ${page ? 'page' : 'index'}`, async () => {
			const fixture = followFixture({ id: 'domain', direction });
			const expected = followSource.cases.find(row => row.id === `${direction}-${page ? 'page-eleven' : 'index'}`)!.expected;
			expect(await readFollowCollection('alice', direction, page, undefined, fixture.reader, followCorpus.defaults.selfUrl)).toEqual({ collection: expected.json });
			expect(fixture.events).toEqual(expected.events);
		});
	}
	for (const [condition, name] of [['missing', 'FollowCollectionNotFoundError'], ['private', 'FollowCollectionPrivateError'], ['followers', 'FollowCollectionPrivateError']] as const) {
		test(`${direction} domain rejects ${condition} before relation reads`, async () => {
			const fixture = followFixture({ id: 'domain', direction, missing: condition === 'missing', visibility: condition });
			await expect(readFollowCollection('alice', direction, true, undefined, fixture.reader, followCorpus.defaults.selfUrl)).rejects.toMatchObject({ name });
			expect(fixture.events).toEqual(condition === 'missing' ? ['user'] : ['user', 'profile']);
		});
	}
	test(`${direction} mandatory member failure remains a failure`, async () => {
		const fixture = followFixture({ id: 'domain', direction, missingMember: true });
		await expect(readFollowCollection('alice', direction, true, undefined, fixture.reader, followCorpus.defaults.selfUrl)).rejects.toThrow('member missing');
	});
}
