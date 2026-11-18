/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { projectRecordedChanges } from './parallel-inputs.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const original = 'a猫cdef';
const changes = [
	{ current: 'a猫AAcdef', offset: 4, previous: '', insert: 'AA' },
	{ current: 'a猫def', offset: 4, previous: 'c', insert: '' },
	{ current: 'a猫cde猫', offset: 7, previous: 'f', insert: '猫' },
];
const records = changes.map(({ current, ...patch }) => ({
	previousSha256: sha(original), currentSha256: sha(current), patches: [patch],
}));

test('independently measured transitions reconstruct the common input and each included component', () => {
	const actual = Buffer.from('a猫AAde猫');
	assert.equal(projectRecordedChanges(records, actual).toString(), original);
	for (const { current } of changes) {
		assert.equal(projectRecordedChanges(records, actual, sha(current)).toString(), current);
	}
	const partial = Buffer.from('a猫AAcde猫');
	assert.equal(projectRecordedChanges(records, partial).toString(), original);
	assert.equal(projectRecordedChanges(records, partial, sha(changes[1].current)), partial);
});

test('unrecorded changes remain visible on individual and combined results', () => {
	for (const text of ['a猫AAcdeg', 'a猫AAde犬', 'a猫AAde猫!', 'a犬AAde猫']) {
		const actual = Buffer.from(text);
		assert.equal(projectRecordedChanges(records, actual), actual);
	}
});

test('historical readers retain the text representation for UTF-8 inputs', () => {
	assert.equal(projectRecordedChanges(records, 'a猫AAde猫'), original);
	assert.equal(projectRecordedChanges(records, 'a猫AAde猫', sha(changes[0].current)), changes[0].current);
	assert.equal(projectRecordedChanges(records, 'a猫AAdeg'), 'a猫AAdeg');
});
