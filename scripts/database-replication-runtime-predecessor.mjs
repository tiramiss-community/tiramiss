/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectDatabaseReplicationFinalInput } from './database-replication-final-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/database-options/replication-runtime-predecessor.json', import.meta.url));
assert.equal(sha(record), '28d35329498c0e1c6cff9b20bacef57bc524193ecfca037bca934fbf07a3ba54', 'database replication predecessor seal');
const { files } = JSON.parse(record);

// Only the measured post-save and runtime disposal changes project to their exact prior inputs.
export function projectDatabaseReplicationRuntimeInput(path, actual) {
	actual = projectDatabaseReplicationFinalInput(path, actual);
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
