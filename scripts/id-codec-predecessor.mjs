/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectParallelInput } from './parallel-inputs.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/id-codec/compatibility-predecessor.json', import.meta.url));
assert.equal(sha(record), '27b2f9f55f8725c834f679a3f62a78ad7deb2314c6d7377c88c6fd57b5fb370a', 'ID codec predecessor seal');
const { files } = JSON.parse(record);
assert.deepEqual(Object.keys(files), ['packages/backend-next/src/platform/id-codec.ts']);

// Only this measured boundary change projects to its exact historical input.
export function projectIdCodecInput(path, actual) {
	actual = projectParallelInput(path, actual);
	const binding = Object.hasOwn(files, path) ? files[path] : undefined;
	if (!binding || sha(actual) !== binding.currentSha256) return actual;
	let previous = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(previous.subarray(patch.offset, patch.offset + inserted.length), inserted, 'ID codec predecessor anchor');
		previous = Buffer.concat([previous.subarray(0, patch.offset), Buffer.from(patch.previous), previous.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(previous), binding.previousSha256, 'ID codec predecessor identity');
	return previous;
}
