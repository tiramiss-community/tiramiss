/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { localActorTagDigest, validateLocalActorTagEvidence } from './local-actor-tags-evidence.mjs';
const directory = new URL('../docs/superpowers/compatibility/remote-user/', import.meta.url);
const receipt = () => JSON.parse(readFileSync(new URL('local-actor-tags-runtime-evidence.json', directory), 'utf8'));

test('pinned actor source observes raw tag order, individual clocks and failure before key', () => {
	const source = JSON.parse(readFileSync(new URL('local-actor-tags-observations.json', directory), 'utf8'));
	assert.equal(source.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.upstreamHttpMeasured, false);
	assert.deepEqual(Object.keys(source.methods), ['renderPerson', 'getEmojis', 'renderEmoji', 'renderHashtag']);
	assert.equal(new Set(source.cases.map(c => c.id)).size, 12);
	const byId = id => source.cases.find(c => c.id === id).expected;
	assert.deepEqual(byId('empty').tag, []);
	assert.deepEqual(byId('empty').events.map(e => e.op), ['profile', 'key']);
	assert.deepEqual(byId('order-duplicates').tag.map(t => t.name), [':beta:', ':alpha:', ':beta:', '#MiXeD', '#日本 語/#', '#MiXeD']);
	assert.equal(byId('empty-values').tag[0].icon.mediaType, '');
	assert.equal(byId('order-duplicates').tag[0].icon.url, 'https://original.test/alpha');
	assert.deepEqual(byId('clock-before-key').events.map(e => e.op), ['profile', 'emojis', 'emoji', 'clock', 'emoji', 'clock', 'hashtag', 'key']);
	assert.notEqual(byId('clock-before-key').tag[0].updated, byId('clock-before-key').tag[1].updated);
	for (const id of ['profile-failure', 'cache-failure', 'emoji-render-failure', 'hashtag-render-failure']) {
		assert(byId(id).error);
		assert(!byId(id).events.some(e => e.op === 'key'));
	}
});

test('actor tag current bindings come from actual runs and preserve historical receipts', () => validateLocalActorTagEvidence(receipt()));
for (const [name, mutate] of [
	['premature completion', value => { value.postingComplete = true; }],
	['missing runtime', value => { delete value.measurements.integration; }],
	['failed run', value => { value.measurements['full-unit'].outcome = 'FAIL'; }],
	['invented current byte', value => { Object.values(value.files)[0].sha256 = '0'.repeat(64); }],
	['unvalidated file', value => { Object.values(value.files)[0].validatedBy = []; }],
]) {
	test(`actor tag evidence rejects ${name}`, () => {
		const value = receipt(); mutate(value);
		assert.throws(() => validateLocalActorTagEvidence(value));
	});
}
test('actor tag identity projection rejects an unmeasured predecessor', () => {
	assert.throws(() => localActorTagDigest('packages/backend-next/src/composition/remote-users.ts', '0'.repeat(64)));
});
