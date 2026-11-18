/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectNoteChartsInput } from './note-charts-evidence.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
import { metaInitializationPredecessorPaths, readPreMetaInitialization } from './meta-initialization-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/meta-initialization/';
const history = JSON.parse(read(directory + 'lifecycle-predecessor.json')).files;

test('R2 original receipt stays immutable and chart follow-up projects its exact historical product inputs', () => {
	assert.equal(sha(read(directory + 'evidence-r2.json')), '4ac76c2884f0d1c413198648ecbe6b95d12b4f372182bf6f11d73f02d2ebd80a');
	assert.equal(sha(read(directory + 'r2-inputs.json')), '82f78900c034a9158c70affeb18e4cd6edb7349e72085adfa01d92c63b0356fb');
	const previous = JSON.parse(read(directory + 'evidence-r2.json'));
	const current = JSON.parse(read(directory + 'evidence.json'));
	assert.deepEqual(current.runs, previous.runs);
	assert.equal(current.runtimeRevision, previous.runtimeRevision);
	for (const [path, digest] of Object.entries(JSON.parse(read(directory + 'r2-inputs.json')).inputs)) {
		assert.equal(sha(projectNoteChartsInput(path, read(path))), digest, `R2 product input changed: ${path}`);
	}
});

for (const path of metaInitializationPredecessorPaths) {
	test(`both terminal and historical readers project the unchanged measured predecessor: ${path}`, () => {
		assert.equal(readPreMetaInitialization(path).toString(), history[path]);
		assert.equal(readPreAliasKey(path, 'utf8'), history[path]);
		assert.notEqual(sha(read(path)), sha(Buffer.from(history[path])));
	});
	test(`same-scope injected current drift and JSON drift reject before projection: ${path}`, () => {
		let changed;
		const injected = file => file === changed ? Buffer.from('drift') : read(file);
		inEvidenceValidationScope(() => {
			assert.equal(readPreMetaInitialization(path, injected).toString(), history[path]);
			changed = path;
			assert.throws(() => readPreMetaInitialization(path, injected), /drift/);
		});
		changed = undefined;
		inEvidenceValidationScope(() => {
			assert.equal(readPreMetaInitialization(path, injected).toString(), history[path]);
			changed = directory + 'lifecycle-predecessor.json';
			assert.throws(() => readPreMetaInitialization(path, injected), /drift|seal/);
		});
	});
}
