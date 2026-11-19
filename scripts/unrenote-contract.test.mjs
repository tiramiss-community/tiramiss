/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectParallelInput } from './parallel-inputs.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = JSON.parse(read('docs/superpowers/compatibility/unrenote/compatibility-predecessor.json'));

test('unrenote projects only its eight exact shared inputs and preserves unknown drift', () => {
	assert.equal(record.baseline, 'c25f3ee9790a5bf593bbe001e1c37e33395cd827');
	assert.equal(Object.keys(record.files).length, 8);
	for (const [path, binding] of Object.entries(record.files)) {
		const actual = read(path);
		assert.equal(sha(projectParallelInput(path, actual, binding.currentSha256)), binding.currentSha256, path);
		assert.equal(sha(projectParallelInput(path, actual, binding.previousSha256)), binding.previousSha256, path);
		const drift = Buffer.concat([actual, Buffer.from('// unrecorded edit\n')]);
		assert.equal(projectParallelInput(path, drift, binding.previousSha256), drift, path);
	}
	const unrelated = Buffer.from('unrelated');
	assert.equal(projectParallelInput('unrelated', unrelated), unrelated);
});
