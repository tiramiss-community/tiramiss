/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const path = 'docs/superpowers/compatibility/video-ingest/dependency-predecessor.json';
const seal = 'fe0b6132b2f0d30af98f499791c71847cdf9cc0a67d89a2631b6c751c96d9d29';
const affected = ['packages/backend-next/package.json', 'pnpm-lock.yaml'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let parsed;

// Only #281's dependency additions are restored. Every call checks live bytes;
// no product receipt or unrelated source is replaced by this finite projection.
export function createPreVideoIngestDependencyReader(readFile) {
	return input => {
		const bytes = readFile(input);
		if (!affected.includes(input)) {
			return bytes;
		}
		const proof = readFile(path);
		assert.equal(sha(proof), seal, 'video ingest dependency predecessor seal');
		parsed ??= JSON.parse(proof);
		assert.equal(parsed.baseRevision, '0927918fe987cae2fcbf2b69bdb58ee6c5ca734a');
		assert.deepEqual(Object.keys(parsed.files), affected);
		const record = parsed.files[input];
		assert.equal(sha(bytes), record.currentSha256, `video ingest measured current input drift: ${input}`);
		let previous = bytes.toString();
		for (const patch of [...record.changes].reverse()) {
			assert.equal(previous.slice(patch.offset, patch.offset + patch.before.length), patch.before, 'video ingest exact dependency patch');
			previous = previous.slice(0, patch.offset) + patch.after + previous.slice(patch.offset + patch.before.length);
		}
		assert.equal(sha(Buffer.from(previous)), record.previousSha256, 'video ingest exact historical dependency identity');
		return Buffer.from(previous);
	};
}
