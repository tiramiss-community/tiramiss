/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectParallelInput } from './parallel-inputs.mjs';
const directory = new URL('../docs/superpowers/compatibility/api-ip-log/', import.meta.url);
const corpusBytes = readFileSync(new URL('corpus.json', directory));
const corpus = JSON.parse(corpusBytes);
const observations = JSON.parse(readFileSync(new URL('observations.json', directory)));
const sha = value => createHash('sha256').update(value).digest('hex');
test('IP log source observations bind the pinned input and acquisition harness', () => {
	assert.equal(observations.upstreamCommit, corpus.upstreamCommit);
	assert.equal(observations.corpusSha256, sha(corpusBytes));
	assert.equal(observations.probeSha256, sha(readFileSync(new URL('source-probe.mjs', directory))));
	assert.equal(new Set(corpus.cases.map(item => item.id)).size, corpus.cases.length);
	assert.deepEqual(observations.cases.map(item => item.id), corpus.cases.map(item => item.id));
});
test('hour clear retries the insert but the unique user/IP row survives; failures are suppressed', () => {
	const item = id => observations.cases.find(item => item.id === id);
	assert.equal(observations.intervalMs, 3600000);
	assert.equal(observations.clearedTimers, corpus.cases.length);
	assert.equal(item('hour-clear').attempts, 2);
	assert.equal(item('hour-clear').rows.length, 1);
	assert.equal(item('sync-failure').attempts, 1);
	assert.equal(item('async-failure').rejected, 1);
	assert.deepEqual(item('async-failure').rows, []);
});


test('only the recorded IP logging additions project to exact historical inputs; later drift remains visible', () => {
	const predecessor = JSON.parse(readFileSync(new URL('compatibility-predecessor.json', directory)));
	for (const [path, binding] of Object.entries(predecessor.files)) {
		const actual = readFileSync(new URL('../' + path, import.meta.url));
		assert.equal(sha(actual), binding.currentSha256, path);
		assert.equal(sha(projectParallelInput(path, actual, binding.previousSha256)), binding.previousSha256, path);
		const drift = Buffer.concat([actual, Buffer.from('\n')]);
		assert.equal(projectParallelInput(path, drift, binding.previousSha256), drift, path);
	}
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectParallelInput('unrelated', unrelated), unrelated);
});
