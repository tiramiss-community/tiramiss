/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectDatabaseDiagnosticsInput } from './database-diagnostics-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/database-options/replication-final-predecessor.json', import.meta.url));
assert.equal(sha(record), '65bb633870a4e4c0bb735f06362f1bde594ea9539f32aeaa4f92286d8c79c43c', 'database replication predecessor seal');
const { files } = JSON.parse(record);

// Only the measured per-query primary reads and initialization ownership changes project to their prior inputs.
export function projectDatabaseReplicationFinalInput(path, actual) {
	actual = projectDatabaseDiagnosticsInput(path, actual);
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
