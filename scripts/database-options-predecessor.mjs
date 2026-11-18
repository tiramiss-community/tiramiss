/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/database-options/compatibility-predecessor.json', import.meta.url));
assert.equal(sha(record), '43d50b7e54a269fbf4bdc97e59ee73f9e4dbb6ac57d33d3d73fd0007e8981148', 'database options predecessor seal');
const { files } = JSON.parse(record);

// Historical validators compare their original inputs. Only the three exact
// changes from #567 have a predecessor; other bytes reach their existing guards.
export function projectDatabaseOptionsInput(path, actual) {
	if (!Object.hasOwn(files, path)) {
		return actual;
	}
	const binding = files[path];
	if (sha(actual) !== binding.currentSha256) {
		return actual;
	}
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const insert = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert);
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'database options predecessor identity');
	return before;
}
