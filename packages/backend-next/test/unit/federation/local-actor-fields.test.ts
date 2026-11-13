/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { renderLocalActor } from '../../../src/modules/federation/local-actor.js';
import { emptyActorMedia } from '../../helpers/local-actor.js';
import { actorFieldsCorpus, actorFieldsProjection, actorFieldsSource } from '../../helpers/local-actor-fields.js';

// Dropped facts, truthy numeric defaults, null aliases, URI normalization, deduplication,
// or bot precedence over dotted system names break independently captured source JSON.
for (const c of actorFieldsCorpus.cases.filter(row => !row.fail)) {
	test(`source ${c.id} preserves selected stored actor fields as serialized JSON`, () => {
		const expected = actorFieldsSource.cases.find(row => row.id === c.id)!.expected;
		expect(expected.error).toBeUndefined();
		const user = { ...actorFieldsCorpus.defaults.user, ...c.user };
		const body = renderLocalActor(user, actorFieldsCorpus.defaults.profile, actorFieldsCorpus.defaults.url, 'key', [], emptyActorMedia);
		expect(actorFieldsProjection(body)).toEqual(expected.json);
	});
}
