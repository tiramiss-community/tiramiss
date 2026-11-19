/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectParallelInput, projectRecordedChanges } from './parallel-inputs.mjs';

const directory = new URL('../docs/superpowers/compatibility/note-personal-state/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('personal state expectations remain reproducible from pinned upstream Git blobs', () => {
	execFileSync(process.execPath, [new URL('source-probe.mjs', directory).pathname, '--check'], { stdio: 'pipe' });
	const observations = JSON.parse(readFileSync(new URL('observations.json', directory)));
	assert.equal(observations.corpusSha256, hash(readFileSync(new URL('corpus.json', directory))));
	assert.equal(observations.cases.length, 26);
	assert.equal(observations.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
});

const predecessor = JSON.parse(readFileSync(new URL('compatibility-predecessor.json', directory)));
for (const [path, binding] of Object.entries(predecessor.files)) {
	test(`personal state preserves only the exact measured predecessor: ${path}`, () => {
		const bytes = readFileSync(new URL('../' + path, import.meta.url));
		const component = projectParallelInput(path, bytes, binding.currentSha256);
		assert.equal(hash(component), binding.currentSha256);
		const previous = execFileSync('git', ['show', `${predecessor.baseline}:${path}`], { cwd: new URL('../', import.meta.url) });
		assert.deepEqual(projectRecordedChanges([binding], component, binding.previousSha256), previous);
		assert.deepEqual(projectParallelInput(path, bytes, binding.previousSha256), previous);
		const drift = Buffer.concat([bytes, Buffer.from('\n')]);
		assert.deepEqual(projectParallelInput(path, drift, binding.previousSha256), drift);
	});
}
