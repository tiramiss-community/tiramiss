/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPollRecommendationInput, validateNotesPaginationEvidence } from './notes-pagination-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/poll-recommendation/';

const shared = 'packages/backend-next/test/unit/composition/http-app.test.ts';
function pollOnly(path, bytes) {
	if (path === shared) bytes = Buffer.from(bytes.toString().replace(", '/api/users/relation'", ''));
	if (path !== shared || sha(bytes) !== 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2') return bytes;
	const memoLine = "\t\t'/api/users/update-memo',\n";
	assert.equal(bytes.toString().split(memoLine).length, 2, 'exact combined memo anchor');
	const before = Buffer.from(bytes.toString().replace(memoLine, ''));
	assert.equal(sha(before), 'fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e');
	return before;
}

test('poll route additions preserve the immutable notes R3 proof and reject all changed bytes', () => {
	const predecessor = JSON.parse(read(directory + 'predecessor.json'));
	assert.deepEqual(Object.keys(predecessor.files), [
		'packages/backend-next/src/composition/note-routes.ts',
		'packages/backend-next/test/unit/composition/http-app.test.ts',
	]);
	const r3 = JSON.parse(read('docs/superpowers/compatibility/notes-pagination/current-evidence.json'));
	for (const [path, binding] of Object.entries(predecessor.files)) {
		const current = pollOnly(path, read(path));
		const before = projectPollRecommendationInput(path, current);
		assert.equal(sha(current), binding.currentSha256);
		assert.equal(sha(before), r3.inputs[path]);
		assert.equal(sha(before), binding.previousSha256);
		assert.throws(() => projectPollRecommendationInput(path, before), /measured current input drift/);
		assert.throws(() => projectPollRecommendationInput(path, Buffer.concat([read(path), Buffer.from('\n')])), /measured current input drift/);
		assert.throws(() => validateNotesPaginationEvidence(undefined, file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), () => null), /measured current input drift/);
	}
	validateNotesPaginationEvidence(undefined, read, () => null);
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectPollRecommendationInput('unrelated', unrelated), unrelated);
});

test('recorded pinned source identifies the required credential and the exact source bytes', () => {
	const source = JSON.parse(read(directory + 'source-observations.json'));
	assert.equal(source.identity.revision, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.meta.requireCredential, true);
	assert.equal(source.meta.kind, 'read:account');
	assert.equal(source.schema.properties.offset.minimum, undefined);
	assert.equal(source.identity.path, 'packages/backend/src/server/api/endpoints/notes/polls/recommendation.ts');
	assert.match(source.identity.sha256, /^[a-f0-9]{64}$/);
	const observations = JSON.parse(read(directory + 'pg-observations.json'));
	assert.deepEqual(observations.identity, source.identity);
	assert.equal(observations.persistenceUnchanged, true);
	assert.equal(observations.observations.length, 9);
	assert.deepEqual(observations.observations[0].ids, [114, 113, 112, 111, 110, 109, 108, 107, 106, 105]);
});


test('known combined composition retains only poll additions for the poll proof', () => {
	const input = read(shared).toString().replace(", '/api/users/relation'", '');
	const combined = sha(input) === 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2' ? input
		: input.replace("\t\t'/api/drive/files/show',", "\t\t'/api/users/update-memo',\n\t\t'/api/drive/files/show',");
	assert.equal(sha(combined), 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2');
	assert.equal(sha(projectPollRecommendationInput(shared, pollOnly(shared, Buffer.from(combined)))), 'a2f030dbfecfa3644a09d1d1aca81a8693ffec7dbad1bc3ceac9894fb46be5eb');
	assert.throws(() => projectPollRecommendationInput(shared, pollOnly(shared, Buffer.from(combined + '\n'))), /measured current input drift/);
});
