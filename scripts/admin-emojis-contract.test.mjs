/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectParallelInput } from './parallel-inputs.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/admin-emojis/';
const predecessor = JSON.parse(read(directory + 'compatibility-predecessor.json'));
for (const [path, binding] of Object.entries(predecessor.files)) {
	test(`admin emoji exact additive predecessor and drift rejection: ${path}`, () => {
		const actual = read(path);
		assert.equal(sha(projectParallelInput(path, actual, binding.previousSha256)), binding.previousSha256);
		assert.equal(sha(projectParallelInput(path, actual, binding.currentSha256)), binding.currentSha256);
		const drift = Buffer.concat([actual, Buffer.from('unexpected drift')]);
		assert.equal(projectParallelInput(path, drift, binding.previousSha256), drift);
	});
}
const fixtureDirectory = 'packages/backend-next/test/fixtures/admin-emojis/';
const manifest = JSON.parse(read(fixtureDirectory + 'manifest.json'));
test('admin emoji source fixtures retain exact pinned source identity', () => {
	assert.equal(sha(read(fixtureDirectory + 'manifest.json')), '19094c9de14860b32f654130a45670c72c59597bf9f98a20ff80271e65a7bd03');
	assert.equal(manifest.revision, '8e07cf085adf7009583d234a208e30436f020e26');
	for (const [name, source] of Object.entries(manifest.files)) {
		assert.equal(sha(read(fixtureDirectory + name + '.ts.txt')), source.sha256);
	}
});

test('admin emoji measurement binds current product and source inputs', () => {
	const bytes = read(directory + 'current-evidence.json');
	assert.equal(sha(bytes), 'afc28d85a25cf5aa98beaaf64c11ad0fcb22f57542fb80d45467102f747f0c99');
	const record = JSON.parse(bytes);
	assert.equal(record.scope, 'admin-emojis-537');
	assert.equal(record.upstreamFullServerMeasured, false);
	for (const [path, expected] of Object.entries(record.inputs)) {
		assert.equal(sha(projectParallelInput(path, read(path), expected)), expected, path);
	}
	for (const run of record.runs) {
		assert.equal(run.exitCode, 0);
		try {
			assert.equal(sha(readFileSync(run.log)), run.logSha256, run.name);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
});
