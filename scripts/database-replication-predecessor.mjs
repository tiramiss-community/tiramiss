/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/database-options/replication-predecessor.json', import.meta.url));
assert.equal(sha(record), 'd9f7e9ca979b0e9cc53a306e494507803096568a1057c9da163a3f40069556dc', 'database replication predecessor seal');
const { files } = JSON.parse(record);

// The measured replica adapter supersedes this one exact input, not its historical measurements.
export function projectDatabaseReplicationInput(path, actual) {
	const binding = files[path];
	if (!binding || sha(actual) !== binding.currentSha256) {
		return actual;
	}
	let previous = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(previous.subarray(patch.offset, patch.offset + inserted.length), inserted, 'database replication predecessor anchor');
		previous = Buffer.concat([previous.subarray(0, patch.offset), Buffer.from(patch.previous), previous.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(previous), binding.previousSha256, 'database replication predecessor identity');
	return previous;
}
