/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeHashtagResult, canonicalizeHashtagObservations } from '../docs/superpowers/compatibility/hashtag-catalog/comparison.mjs';

const rows = [
	{ name: 'alpha', mentionedLocalUsersCount: 4, attachedUsersCount: 4 },
	{ name: 'beta', mentionedLocalUsersCount: 3, attachedUsersCount: 3 },
	{ name: 'gamma', mentionedLocalUsersCount: 3, attachedUsersCount: 3 },
	{ name: 'delta', mentionedLocalUsersCount: 1, attachedUsersCount: 1 },
];
const listCase = { id: 'list', endpoint: 'list', input: { sort: '+attachedUsers' } };
const list = [{ tag: 'alpha', attachedUsersCount: 4 }, { tag: 'beta', attachedUsersCount: 3 }, { tag: 'gamma', attachedUsersCount: 3 }, { tag: 'delta', attachedUsersCount: 1 }];
const searchCase = { id: 'search', endpoint: 'search', input: { query: '', offset: 1, limit: 2 } };
const canonical = value => canonicalizeHashtagResult(listCase, value, rows);

test('only equal-count list runs can change order in either direction', () => {
	assert.deepEqual(canonical([list[0], list[2], list[1], list[3]]), canonical(list));
	const ascending = { ...listCase, input: { sort: '-attachedUsers' } };
	assert.deepEqual(canonicalizeHashtagResult(ascending, [list[3], list[2], list[1], list[0]], rows), canonicalizeHashtagResult(ascending, [...list].reverse(), rows));
	assert.throws(() => canonical([list[1], list[0], list[2], list[3]]), /rank order/);
});

test('list member corruption, field corruption and duplicate members still fail', () => {
	for (const corrupt of [
		[list[0], { ...list[1], tag: 'other' }, list[2], list[3]],
		[list[0], { ...list[1], mentionedUsersCount: 99 }, list[2], list[3]],
		[list[0], list[1], list[1], list[3]],
	]) {
		assert.throws(() => assert.deepEqual(canonical(corrupt), canonical(list)));
	}
});

test('search ties preserve exact page membership and reject wrong ranks and unknown or duplicate names', () => {
	const compare = result => canonicalizeHashtagResult(searchCase, result, rows);
	assert.deepEqual(compare(['gamma', 'beta']), compare(['beta', 'gamma']));
	assert.throws(() => assert.deepEqual(compare(['alpha', 'beta']), compare(['beta', 'gamma'])));
	assert.throws(() => compare(['delta', 'beta']), /rank order/);
	assert.throws(() => compare(['beta', 'unknown']), /unknown search member/);
	assert.throws(() => compare(['beta', 'beta']), /duplicate/);
});

test('source comparison preserves metadata, errors, case identity and complete row fields', () => {
	const corpus = { rows, cases: [listCase, searchCase, { id: 'missing', endpoint: 'show', input: { tag: 'unknown' } }] };
	const baseline = { meta: { pinned: 'source' }, cases: [{ id: 'list', result: list }, { id: 'search', result: ['beta', 'gamma'] }, { id: 'missing', error: { code: 'NO_SUCH_HASHTAG' } }] };
	const changed = structuredClone(baseline);
	changed.cases[0].result = [list[0], list[2], list[1], list[3]];
	changed.cases[1].result.reverse();
	const normalize = value => canonicalizeHashtagObservations(value, corpus);
	assert.deepEqual(normalize(changed), normalize(baseline));
	for (const mutate of [value => { value.meta.pinned = 'changed'; }, value => { value.cases[2].error.code = 'changed'; }, value => { value.cases[0].result[0].tag = 'changed'; }]) {
		const corrupt = structuredClone(baseline);
		mutate(corrupt);
		assert.throws(() => assert.deepEqual(normalize(corrupt), normalize(baseline)));
	}
	assert.throws(() => normalize({ ...baseline, cases: [...baseline.cases].reverse() }), /case identity/);
});

test('fixtures cannot hide arbitrary tied members behind offset or limit boundaries', () => {
	for (const input of [{ query: '', offset: 2, limit: 2 }, { query: '', offset: 0, limit: 2 }]) {
		assert.throws(() => canonicalizeHashtagResult({ ...searchCase, input }, ['gamma', 'delta'], rows), /page boundary splits a tied rank/);
	}
});
