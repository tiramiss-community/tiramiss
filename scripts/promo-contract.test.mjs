/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPromoInput } from './promo-predecessor.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/promo/';

test('promo source observations bind the finite corpus and source manifest without claiming full upstream HTTP', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observed = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observed.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observed.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.deepEqual(observed.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(new Set(observed.cases.map(item => item.id)).size, 18);
	assert.deepEqual(observed.access, { requireCredential: true, requireModerator: true, kind: 'write:admin:promo' });
	assert.equal(observed.manifest.length, 3);
	assert.match(observed.doubles, /Neither mode runs full upstream HTTP/);
});

test('promo additive inputs preserve exact historical bytes and pass unknown drift to existing guards', () => {
	const { files } = JSON.parse(read(directory + 'compatibility-predecessor.json'));
	assert.equal(Object.keys(files).length, 6);
	for (const [path, binding] of Object.entries(files)) {
		const current = read(path);
		assert.equal(sha(current), binding.currentSha256);
		assert.equal(sha(projectPromoInput(path, current)), binding.previousSha256);
		const drift = Buffer.concat([current, Buffer.from('\n')]);
		assert.equal(projectPromoInput(path, drift), drift);
		const previous = projectPromoInput(path, current);
		assert.equal(projectPromoInput(path, previous), previous);
	}
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectPromoInput('unrelated', unrelated), unrelated);
});
