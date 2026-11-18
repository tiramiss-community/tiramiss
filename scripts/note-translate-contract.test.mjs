/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectNoteTranslationInput, validateNotesPaginationEvidence } from './notes-pagination-evidence.mjs';

const path = 'packages/backend-next/src/composition/note-routes.ts';
const read = file => readFileSync(new URL('../' + file, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('translation registration restores only the exact previous poll registration bytes', () => {
	const current = read(path);
	const previous = projectNoteTranslationInput(path, current);
	assert.equal(sha(current), 'acc54edcb294f989c41d2a3680587e4f0789d3edef3900b840a9c084269ee353');
	assert.equal(sha(previous), '2f7242d5d7b5ffcaf03a505c1ceabc2fedb1588bf88b49a1bc4ddbdf77e11b2a');
	assert.equal(projectNoteTranslationInput(path, previous), previous);
	const drift = Buffer.concat([current, Buffer.from('\n')]);
	assert.equal(projectNoteTranslationInput(path, drift), drift);
	const historicalDrift = Buffer.concat([previous, Buffer.from('\n')]);
	assert.equal(projectNoteTranslationInput(path, historicalDrift), historicalDrift);
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectNoteTranslationInput('unrelated', unrelated), unrelated);
	validateNotesPaginationEvidence(undefined, read, () => null);
	assert.throws(() => validateNotesPaginationEvidence(undefined, file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), () => null), /measured current input drift/);
});

test('translation fixture and route assertion preserve the exact historical composition input', () => {
	const target = 'packages/backend-next/test/unit/composition/http-app.test.ts';
	const current = read(target);
	const previous = projectNoteTranslationInput(target, current);
	assert.equal(sha(previous), 'cadc10344ec0024592e4aeb73730d369fe10b53a1de4d4dfa4ef88b1a38e203b');
	assert.notEqual(sha(current), sha(previous));
	validateNotesPaginationEvidence(undefined, read, () => null);
	assert.throws(() => validateNotesPaginationEvidence(undefined, file => file === target ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), () => null), /measured current input drift/);
});
