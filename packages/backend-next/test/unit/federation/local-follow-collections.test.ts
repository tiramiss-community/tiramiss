/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createActivityPubFollowCollectionsApi } from '../../../src/http/activitypub-follow-collections-api.js';
import { readFollowCollection } from '../../../src/modules/federation/local-follow-collections.js';
import { followCorpus, followFixture, followSource } from '../../helpers/local-follow-collections.js';

test.each(followCorpus.cases)('$id matches fixed literal-source HTTP, representation and failure order', async (c) => {
	const fixture = followFixture(c);
	const logger = { error: vi.fn() };
	let metaEntries = 0;
	const app = createActivityPubFollowCollectionsApi({
		federationEnabled: async () => {
			metaEntries++;
			return c.federation !== 'none';
		},
		logger,
		readCollection: (id, direction, page, cursor) => readFollowCollection(id, direction, page, cursor, fixture.reader, followCorpus.defaults.selfUrl),
	});
	const expected = followSource.cases.find(row => row.id === c.id)!.expected;
	const response = await app.request(`/users/${c.pathUser ?? 'alice'}/${c.direction}${c.query ?? ''}`, {
		method: c.method ?? 'GET', headers: c.accept === null ? {} : { Accept: c.accept ?? 'application/activity+json' },
	});
	expect(response.status).toBe(expected.status);
	for (const [key, value] of Object.entries(expected.headers)) {
		expect(response.headers.get(key), key).toBe(value);
	}
	if (expected.json) {
		expect(await response.json()).toEqual(expected.json);
	} else if (expected.errorProjection) {
		expect(await response.json()).toMatchObject(expected.errorProjection);
	} else if (expected.bodyEmpty || c.method === 'HEAD') {
		expect(await response.text()).toBe('');
	}
	expect(fixture.events).toEqual(expected.events);
	expect(fixture.relationCursors).toEqual(expected.relationCursors);
	expect(fixture.lookupIds).toEqual(expected.lookupIds);
	expect(metaEntries).toBe(expected.metaEntries);
	expect(logger.error).toHaveBeenCalledTimes(expected.status === 500 ? 1 : 0);
});
