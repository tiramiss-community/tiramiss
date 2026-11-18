/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/database-options/diagnostics-predecessor.json', import.meta.url));
assert.equal(sha(record), '74830c39c0a529ce0a4d0b4d3f78b0f8b621e1ea772869a8f48ab27938ff131d', 'database diagnostics predecessor seal');
const { files } = JSON.parse(record);

// Only these exact measured diagnostic changes project to the prior input; later drift remains visible.
export function projectDatabaseDiagnosticsInput(path, actual) {
	const binding = files[path];
	if (!binding || sha(actual) !== binding.currentSha256) {
		return actual;
	}
	let previous = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(previous.subarray(patch.offset, patch.offset + inserted.length), inserted, 'database diagnostics predecessor anchor');
		previous = Buffer.concat([previous.subarray(0, patch.offset), Buffer.from(patch.previous), previous.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(previous), binding.previousSha256, 'database diagnostics predecessor identity');
	return previous;
}
