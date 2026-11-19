/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectParallelInput } from './parallel-inputs.mjs';
const directory = 'docs/superpowers/compatibility/drive-list-usage/';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
test('Drive list observations bind all111 source cases and their actual HTTP/PG consumer', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observations = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observations.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observations.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.deepEqual(observations.cases.map(c => c.id), corpus.cases.map(c => c.id));
	assert.equal(observations.cases.length, 111);
	assert.equal(new Set(observations.manifest.map(item => item.path)).size, 10);
	for (const item of observations.manifest) {
		assert.match(item.sha256, /^[a-f0-9]{64}$/);
		assert.match(item.gitBlob, /^[a-f0-9]{40}$/);
	}
	const consumer = read('packages/backend-next/test/integration/drive-list-source-http.test.ts').toString();
	assert(consumer.includes('corpus.cases'));
	assert(consumer.includes('observations.cases.find'));
	assert(consumer.includes('createDriveUsageReader'));
});
test('only exact list integration changes project to their historical inputs and drift stays visible', () => {
	const saved = JSON.parse(read(directory + 'compatibility-predecessor.json'));
	assert.deepEqual(Object.keys(saved.files), ['packages/backend-next/src/composition/drive-files-http.ts', 'packages/backend-next/src/platform/database/drive-files.ts', 'packages/backend-next/test/unit/composition/http-app.test.ts']);
	for (const [path, binding] of Object.entries(saved.files)) {
		const current = read(path);
		assert.equal(sha(projectParallelInput(path, current, binding.currentSha256)), binding.currentSha256);
		assert.equal(sha(projectParallelInput(path, current, binding.previousSha256)), binding.previousSha256);
		const drift = Buffer.concat([current, Buffer.from('\n')]);
		assert.equal(projectParallelInput(path, drift, binding.previousSha256), drift);
	}
});
