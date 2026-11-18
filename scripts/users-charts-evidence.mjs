/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { projectParallelInput } from './parallel-inputs.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const evidencePath = 'docs/superpowers/compatibility/users-charts/current-evidence.json';
const seal = '95fce375fb4b3f09fed042fb08515944310b0c3177d421d244b4746de92242da';
function optionalRead(path) {
	try {
		return readFileSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

export function validateUsersChartsEvidence(readFile = read, optional = optionalRead) {
	const bytes = readFile(evidencePath);
	assert.equal(sha(bytes), seal, 'users chart evidence seal');
	const current = JSON.parse(bytes);
	assert.equal(current.scope, 'users-chart-319');
	assert.equal(current.upstreamFullServerMeasured, false);
	assert.equal(current.postingComplete, false);
	for (const [path, expected] of Object.entries(current.inputs)) {
		assert.equal(sha(projectParallelInput(path, readFile(path), expected)), expected, `users chart current input drift: ${path}`);
	}
	const corpus = JSON.parse(readFile('docs/superpowers/compatibility/users-charts/source-observations.json'));
	assert.equal(corpus.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual([corpus.updates.length, corpus.resyncs.length, corpus.reads.length], [4, 2, 24]);
	for (const run of current.runs) {
		assert.equal(run.exitCode, 0);
		const log = optional(run.log);
		if (log !== null) assert.equal(sha(log), run.logSha256, 'users chart actual log drift');
	}
	return current;
}

export function validateUsersChartsReviewEvidence(readFile = read, optional = optionalRead) {
	const bytes = readFile('docs/superpowers/compatibility/users-charts/review-evidence.json');
	assert.equal(sha(bytes), '203ec3d9090839ffc90acc394eb3c8ce78dba69df6ba6e4524ab13c800a9f816', 'users chart review evidence seal');
	const current = JSON.parse(bytes);
	assert.equal(current.runtimeUnchanged, true);
	for (const [path, binding] of Object.entries(current.files)) {
		assert.equal(sha(projectParallelInput(path, readFile(path), binding.currentSha256)), binding.currentSha256, 'users chart reviewed test drift');
	}
	assert.equal(current.run.exitCode, 0);
	assert.equal(current.run.passed, 5);
	const log = optional(current.run.log);
	if (log !== null) assert.equal(sha(log), current.run.logSha256, 'users chart review log drift');
	return current;
}
