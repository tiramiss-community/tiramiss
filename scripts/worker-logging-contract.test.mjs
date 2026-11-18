/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectWorkerLoggingInput, validateWorkerLoggingEvidence } from './worker-logging-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const offline = () => null;

test('worker logging successor has actual focused and process measurements, while historical bytes remain historical', () => {
	const value = validateWorkerLoggingEvidence(read, offline);
	assert.equal(value.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(Object.keys(value.predecessors).length, 7);
	assert.deepEqual(value.runs.filter(run => run.artifact).map(run => [run.name, run.passed, run.skipped]), [['focused', 95, 0], ['process', 5, 0]]);
	for (const [path, binding] of Object.entries(value.predecessors)) {
		assert.equal(sha(projectWorkerLoggingInput(path, read(path))), binding.previousSha256);
		const drift = Buffer.concat([read(path), Buffer.from('\n')]);
		assert.equal(projectWorkerLoggingInput(path, drift), drift, 'unknown bytes reach existing guards');
	}
	const unrelated = Buffer.from('untouched');
	assert.equal(projectWorkerLoggingInput('unrelated', unrelated), unrelated);
});

test('worker logging measured files, record and available raw logs reject corruption', () => {
	const value = validateWorkerLoggingEvidence(read, offline);
	for (const path of Object.keys(value.currentInputs)) {
		assert.throws(() => validateWorkerLoggingEvidence(file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), offline), /worker logging measured input drift/);
	}
	assert.throws(() => validateWorkerLoggingEvidence(path => path.endsWith('runtime-evidence.json') ? Buffer.from('{}') : read(path), offline), /worker logging evidence seal/);
	for (const run of value.runs) {
		assert.throws(() => validateWorkerLoggingEvidence(read, path => path === run.log ? Buffer.from('forged') : null), /actual log drift/);
		if (run.artifact) {
			assert.throws(() => validateWorkerLoggingEvidence(read, path => path === run.artifact ? Buffer.from('{}') : null), /actual test artifact drift/);
		}
	}
	validateWorkerLoggingEvidence();
});
