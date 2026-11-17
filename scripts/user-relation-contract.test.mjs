/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectUserMemoInput } from './notes-pagination-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/user-relation/';

test('fixed relation observations cover singleton array, duplicates, directions, unknown and empty targets', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observed = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observed.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observed.corpusSha256, hash(read(directory + 'corpus.json')));
	assert.deepEqual(observed.access, { requireCredential: true, kind: 'read:account' });
	assert.equal(observed.manifest.length, 2);
	assert.deepEqual(observed.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(observed.cases.length, 26);
	assert.equal(observed.cases[0].result.length, 1);
	assert.equal(observed.cases[0].result[0].following.notify, 'normal');
	assert.equal(observed.cases[0].result[0].following.withReplies, true);
	assert.deepEqual(observed.cases[3].result, []);
	assert.deepEqual(observed.cases[4].result.map(item => item.id), ['carol', 'bob', 'unknown', 'alice', 'empty']);
	assert.equal(observed.cases[4].result[2].following, null);
	assert.equal(observed.cases[4].result[2].isFollowing, false);
	assert.equal(observed.cases[9].result[3].isFollowed, true);
	assert(observed.cases.slice(-6).every(item => item.error.code === 'INVALID_PARAM'));
});

test('relation registration projects only its exact additions through the existing finite memo follow-up', () => {
	for (const [path, digest] of [
		['packages/backend-next/src/composition/http-app.ts', 'e8851b4ec5bba14758c315e98368105051463cb7cba8d26b3c18ad332ff381cc'],
		['packages/backend-next/test/unit/composition/http-app.test.ts', 'fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e'],
	]) {
		const actual = read(path);
		assert.equal(hash(projectUserMemoInput(path, actual)), digest);
		assert.throws(() => projectUserMemoInput(path, Buffer.concat([actual, Buffer.from('\n')])), /measured current input drift/);
		assert.throws(() => projectUserMemoInput(path, Buffer.from(actual.toString().replace(path.includes('/src/') ? 'createUserRelationHttp' : 'users/relation', 'changedRelation'))), /measured current input drift/);
	}
});
