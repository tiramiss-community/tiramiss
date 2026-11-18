/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectParallelInput } from './parallel-inputs.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectNoteTranslationInput } from './note-translate-predecessor.mjs';
import { projectUserMemoInput, validateNotesPaginationEvidence } from './notes-pagination-evidence.mjs';

const path = 'packages/backend-next/src/composition/http-app.ts';
const read = file => readFileSync(new URL('../' + file, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('central translation registration restores only the exact previous promo composition bytes', () => {
	const current = projectParallelInput(path, read(path));
	const previous = projectNoteTranslationInput(path, current);
	assert.equal(sha(current), '3747f04e5de5e43d5eda0ac7ef856ce7a369cb818e31d159eb85320a7ee7e08a');
	assert.equal(sha(previous), '0af728aaf5942450d8066540a1ab83a29b4bc16cdb3ba51ecca3df395c366b7c');
	assert.equal(projectNoteTranslationInput(path, previous), previous);
	const drift = Buffer.concat([current, Buffer.from('\n')]);
	assert.equal(projectNoteTranslationInput(path, drift), drift);
	const historicalDrift = Buffer.concat([previous, Buffer.from('\n')]);
	assert.equal(projectNoteTranslationInput(path, historicalDrift), historicalDrift);
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectNoteTranslationInput('unrelated', unrelated), unrelated);
	validateNotesPaginationEvidence(undefined, read, () => null);
	assert.throws(() => projectUserMemoInput(path, Buffer.concat([read(path), Buffer.from('\n')])), /input drift/);
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
