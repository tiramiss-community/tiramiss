/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { notesPaginationPredecessorFiles, validateNotesPaginationEvidence, projectNotesPaginationInput } from './notes-pagination-evidence.mjs';
import { inEvidenceValidationScope, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';
import { readForActorEmojiCacheEvidence, validateActorEmojiBatchEvidence } from './actor-emoji-cache-evidence.mjs';
import { readPreAvatarImages } from './avatar-images-evidence.mjs';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/notes-pagination/';
const offline = () => null;

test('notes comparison documents trigger the normal backend contract CI on push and pull requests', () => {
	const yaml = createRequire(new URL('../packages/backend-next/package.json', import.meta.url))('js-yaml');
	const workflow = yaml.load(read('.github/workflows/test-backend-next.yml').toString());
	for (const event of ['push', 'pull_request']) {
		assert(workflow.on[event].paths.includes('docs/superpowers/compatibility/notes-pagination/**'));
	}
	assert(workflow.jobs.contracts.steps.some(step => step.run === 'node --test scripts/*-contract*.test.mjs'));
});

test('independent notes measurement binds all15 current inputs and the exact five follow-up constants', () => {
	const before = validateNotesPaginationEvidence(undefined, read, offline);
	assert.deepEqual(Object.keys(before), notesPaginationPredecessorFiles);
	for (const path of notesPaginationPredecessorFiles) {
		assert.equal(projectNotesPaginationInput(path, read(path)).toString(), before[path]);
		assert.throws(() => projectNotesPaginationInput(path, Buffer.from(before[path])), /measured current input drift/);
		assert.throws(() => projectNotesPaginationInput(path, Buffer.concat([read(path), Buffer.from('\n')])), /measured current input drift/);
	}
	const unrelated = Buffer.from('independent');
	assert.equal(projectNotesPaginationInput('unrelated', unrelated), unrelated);
});

test('independent notes proof rejects every measured input, historical bytes as current, and record corruption', () => {
	const value = JSON.parse(read(directory + 'current-evidence.json'));
	for (const path of Object.keys(value.inputs)) {
		assert.throws(() => validateNotesPaginationEvidence(undefined, file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), offline), /measured current input drift/);
	}
	const before = validateNotesPaginationEvidence(undefined, read, offline);
	assert.throws(() => validateNotesPaginationEvidence(undefined, path => Object.hasOwn(before, path) ? Buffer.from(before[path]) : read(path), offline), /measured current input drift/);
	for (const name of ['current-evidence.json', 'predecessor.json', 'r1-current-evidence.json', 'r1-predecessor.json', 'r2-current-evidence.json']) {
		assert.throws(() => validateNotesPaginationEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), offline), /seal/);
	}
});

test('independent notes proof retains requested input, JSON metadata, reader identity and optional-log checks in warm scopes', () => {
	const requested = notesPaginationPredecessorFiles[0];
	const value = JSON.parse(read(directory + 'current-evidence.json'));
	for (const target of [requested, directory + 'current-evidence.json', directory + 'observations.json']) {
		let changed = false;
		const dynamic = path => path === target && changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
		inEvidenceValidationScope(() => {
			withEvidenceRequestedPath(requested, () => validateNotesPaginationEvidence(undefined, dynamic, offline));
			changed = true;
			assert.throws(() => withEvidenceRequestedPath(requested, () => validateNotesPaginationEvidence(undefined, dynamic, offline)), /seal|input drift/);
			validateNotesPaginationEvidence(undefined, read, offline);
		});
	}
	let forged = false;
	const optional = path => forged && path === value.runs[0].log ? Buffer.from('forged PASS') : null;
	inEvidenceValidationScope(() => {
		validateNotesPaginationEvidence(undefined, read, optional);
		forged = true;
		assert.throws(() => validateNotesPaginationEvidence(undefined, read, optional), /actual log.*drift/);
	});
	for (const run of value.runs) {
		assert.throws(() => validateNotesPaginationEvidence(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log.*drift/);
	}
});

test('historical leaves retain their own live shared-input and reader identity guarantees', () => {
	for (const [entry, requested] of [[readForActorEmojiCacheEvidence, notesPaginationPredecessorFiles[0]], [readPreAvatarImages, notesPaginationPredecessorFiles.at(-1)]]) {
		let changed = false;
		const dynamic = path => path === requested && changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
		inEvidenceValidationScope(() => {
			entry(requested, dynamic, offline);
			changed = true;
			assert.throws(() => entry(requested, dynamic, offline), /measured current input drift/);
			assert(Buffer.isBuffer(entry(requested, read, offline)));
		});
	}
	for (const requested of ['packages/backend-next/src/platform/database/note-reader.ts', 'docs/superpowers/compatibility/actor-emoji-cache/batch-current-evidence.json']) {
		let changed = false;
		const dynamic = path => path === requested && changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
		inEvidenceValidationScope(() => {
			validateActorEmojiBatchEvidence(undefined, dynamic, offline);
			changed = true;
			assert.throws(() => validateActorEmojiBatchEvidence(undefined, dynamic, offline), /seal|input drift/);
		});
	}
});

test('historical alias readers restore Note public exports and reject live input mutation', () => {
	const path = 'packages/backend-next/src/modules/note/public.ts';
	const before = validateNotesPaginationEvidence(undefined, read, offline);
	assert.equal(readPreAliasKey(path, undefined, read).toString(), before[path]);
	assert.throws(() => readPreAliasKey(path, undefined, file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file)), /measured current input drift/);
});
