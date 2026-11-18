/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectParallelInput } from './parallel-inputs.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/promo-read/compatibility-predecessor.json', import.meta.url));
assert.equal(sha(record), 'bd03977dd7f02413127a7df086529823c23e9026426e4af9c3aa29ffb405b8cc', 'promo/read predecessor seal');
const { files } = JSON.parse(record);

// Preserve earlier measurements through only the exact additive #530 inputs.
export function projectPromoReadInput(path, actual) {
	actual = projectParallelInput(path, actual);
	const binding = Object.hasOwn(files, path) ? files[path] : undefined;
	if (!binding || sha(actual) !== binding.currentSha256) return actual;
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + inserted.length), inserted, 'promo/read predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'promo/read predecessor identity');
	return before;
}
