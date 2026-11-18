/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { noteChartPredecessorPaths, projectNoteChartsInput, validateNoteChartsEvidence } from './note-charts-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const offline = () => null;

test('chart follow-up records current runs separately from immutable historical projections', () => {
	const value = validateNoteChartsEvidence(read, offline);
	assert.deepEqual(value.runs.map(run => [run.name, run.files, run.passed, run.skipped, run.exitCode]), [
		['unit', 145, 5032, 1, 0], ['integration', 4, 86, 0, 0], ['meta-integration', 1, 3, 0, 0], ['meta-process', 1, 5, 0, 0],
	]);
	assert.equal(Object.keys(value.currentInputs).length, 23);
	assert.equal(noteChartPredecessorPaths.length, 9);
	for (const path of noteChartPredecessorPaths) {
		const previous = projectNoteChartsInput(path, read(path));
		assert.equal(sha(previous), value.predecessors[path].previousSha256);
		assert.notEqual(sha(previous), sha(read(path)));
		const drift = Buffer.concat([read(path), Buffer.from('\n')]);
		assert.equal(projectNoteChartsInput(path, drift), drift, 'unrecognized bytes reach the old layers unchanged for rejection');
	}
	const bytes = Buffer.from('unrelated');
	assert.equal(projectNoteChartsInput('unrelated', bytes), bytes);
});

test('chart current input, receipt and available raw log corruption reject', () => {
	const value = validateNoteChartsEvidence(read, offline);
	for (const path of Object.keys(value.currentInputs)) {
		assert.throws(() => validateNoteChartsEvidence(file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), offline), /measured current input drift/);
	}
	assert.throws(() => validateNoteChartsEvidence(path => path.endsWith('compatibility-predecessor.json') ? Buffer.from('{}') : read(path), offline), /evidence seal/);
	for (const run of value.runs) {
		assert.throws(() => validateNoteChartsEvidence(read, path => path === run.log ? Buffer.from('forged') : null), /actual log drift/);
	}
	validateNoteChartsEvidence();
});


test('empty or shortened chart source corpora cannot turn runtime comparison loops into success', () => {
	const path = 'docs/superpowers/compatibility/note-charts/source-observations.json';
	for (const field of ['updates', 'reads']) {
		for (const empty of [true, false]) {
			const corrupted = JSON.parse(read(path));
			if (empty) corrupted[field] = [];
			else corrupted[field].pop();
			assert.throws(() => validateNoteChartsEvidence(file => file === path ? Buffer.from(JSON.stringify(corrupted)) : read(file), offline), /measured current input drift/);
		}
	}
});
