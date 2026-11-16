/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { notesPaginationPredecessorFiles, validateNotesPaginationEvidence, readBeforeNotesPagination } from './notes-pagination-evidence.mjs';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';
import { readForActorEmojiCacheEvidence } from './actor-emoji-cache-evidence.mjs';
import { readPreAvatarImages } from './avatar-images-evidence.mjs';
import { readForMetaCacheEvidence } from './joint-drive-meta-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/notes-pagination/';

test('notes measurement projects only its exact finite predecessor and passes unrelated bytes through', () => {
	const before = validateNotesPaginationEvidence(undefined, read, () => null);
	assert.deepEqual(Object.keys(before), notesPaginationPredecessorFiles);
	for (const path of notesPaginationPredecessorFiles) {
		assert.equal(readBeforeNotesPagination(path, read, () => null).toString(), before[path]);
	}
	assert.equal(readBeforeNotesPagination('unrelated', () => Buffer.from('independent')).toString(), 'independent');
});
test('notes projection rejects every changed measured input, predecessor-as-current and record corruption', () => {
	const value = JSON.parse(read(directory + 'current-evidence.json'));
	for (const path of Object.keys(value.inputs)) {
		assert.throws(() => validateNotesPaginationEvidence(undefined, file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), () => null), /measured current input drift/);
	}
	const before = validateNotesPaginationEvidence(undefined, read, () => null);
	assert.throws(() => validateNotesPaginationEvidence(undefined, path => Object.hasOwn(before, path) ? Buffer.from(before[path]) : read(path), () => null), /measured current input drift/);
	for (const name of ['current-evidence.json', 'predecessor.json']) {
		assert.throws(() => validateNotesPaginationEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), () => null), /seal/);
	}
});
test('notes projection retains requested drift, independent reader identity and return isolation', () => {
	const requested = notesPaginationPredecessorFiles[0];
	let changed = false;
	const dynamic = path => path === requested && changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
	const optional = () => null;
	inEvidenceValidationScope(() => {
		readBeforeNotesPagination(requested, dynamic, optional);
		changed = true;
		assert.throws(() => readBeforeNotesPagination(requested, dynamic, optional), /measured current input drift/);
		assert(Buffer.isBuffer(readBeforeNotesPagination(requested, read, optional)));
	});
	assert.throws(() => readBeforeNotesPagination(requested, dynamic, optional), /measured current input drift/);
	const mutable = readBeforeNotesPagination(requested, read, optional);
	mutable[0] = 0;
	assert.notEqual(readBeforeNotesPagination(requested, read, optional)[0], 0);
});
test('notes projection validates optional actual logs and does not invent missing runs', () => {
	const value = JSON.parse(read(directory + 'current-evidence.json'));
	for (const run of value.runs) {
		assert.throws(() => validateNotesPaginationEvidence(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
	}
	assert.deepEqual(validateNotesPaginationEvidence(undefined, read, () => null), validateNotesPaginationEvidence(undefined, read, () => null));
});

test('both historical entry points retain successor receipt, requested input and optional-log checks', () => {
	for (const [entry, requested] of [
		[readForActorEmojiCacheEvidence, notesPaginationPredecessorFiles[0]],
		[readPreAvatarImages, notesPaginationPredecessorFiles.at(-1)],
	]) {
		let changed;
		let forgedLog = false;
		const value = JSON.parse(read(directory + 'current-evidence.json'));
		const dynamic = path => path === changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
		const optional = path => forgedLog && path === value.runs[0].log ? Buffer.from('forged PASS') : null;
		inEvidenceValidationScope(() => {
			entry(requested, dynamic, optional);
			changed = requested;
			assert.throws(() => entry(requested, dynamic, optional), /measured current input drift/);
			changed = undefined;
			entry(requested, dynamic, optional);
			forgedLog = true;
			assert.throws(() => entry(requested, dynamic, optional), /actual log.*drift/);
		});
		forgedLog = false;
		inEvidenceValidationScope(() => {
			entry(requested, dynamic, optional);
			changed = directory + 'current-evidence.json';
			assert.throws(() => entry(requested, dynamic, optional), /seal|input drift/);
		});
	}
});

test('joint drive/meta composition preserves the original current reader while projecting historical bytes', () => {
	const requested = notesPaginationPredecessorFiles[0];
	let changed = false;
	const dynamic = path => path === requested && changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
	inEvidenceValidationScope(() => {
		assert(Buffer.isBuffer(readForMetaCacheEvidence(requested, dynamic)));
		changed = true;
		assert.throws(() => readForMetaCacheEvidence(requested, dynamic), /measured current input drift/);
		assert(Buffer.isBuffer(readForMetaCacheEvidence(requested, read)));
	});
});
