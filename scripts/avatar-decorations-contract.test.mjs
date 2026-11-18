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
const record = JSON.parse(readFileSync(new URL('../docs/superpowers/compatibility/avatar-decorations/compatibility-predecessor.json', import.meta.url)));
for (const [path, binding] of Object.entries(record.files)) {
	test(`avatar decoration component and predecessor remain exact after independent merges: ${path}`, () => {
		const actual = readFileSync(new URL('../' + path, import.meta.url));
		assert.equal(sha(projectParallelInput(path, actual, binding.currentSha256)), binding.currentSha256);
		assert.equal(sha(projectParallelInput(path, actual, binding.previousSha256)), binding.previousSha256);
		const drifted = Buffer.concat([actual, Buffer.from('unrecorded drift')]);
		assert.equal(projectParallelInput(path, drifted, binding.previousSha256), drifted);
	});
}

test('literal source observations retain the finite projection and cache boundaries', () => {
	const bytes = readFileSync(new URL('../docs/superpowers/compatibility/avatar-decorations/observations.json', import.meta.url));
	assert.equal(sha(bytes), '6fb148d25bf30b0553e2eef904f58244eabfbef149475bbfee67af029037c343');
	const source = JSON.parse(bytes);
	assert.equal(source.pin, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.projection.length, 2);
	assert.equal(source.timeline.length, 9);
	assert.equal(source.timeline.find(row => row.label === 'exact TTL').reads, 1);
	assert.equal(source.timeline.find(row => row.label === 'expired').reads, 2);
	assert.equal(source.timeline.find(row => row.label === 'forced failure').error, 'DB unavailable');
});
