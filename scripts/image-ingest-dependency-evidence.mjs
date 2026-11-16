/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPreVideoIngestDependencyReader } from './video-ingest-dependency-evidence.mjs';
import { createPreCliPackageReader } from './cli-package-evidence.mjs';
const path = 'docs/superpowers/compatibility/image-ingest/dependency-predecessor.json';
const seal = '31d30a5fc7b3e63087ad39e046af488bdef12c76128ec7bb6a99854e9a8e6236';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const affected = new Set(['packages/backend-next/package.json', 'pnpm-lock.yaml']);

// Only the two dependency inputs changed by #280 are projected. Product receipts
// and all other historical inputs remain immutable and are still read live.
export function createPreImageIngestDependencyReader(readFile) {
	const beforeVideo = createPreVideoIngestDependencyReader(readFile);
	const rawRead = readFile;
	readFile = createPreCliPackageReader(input => input === 'pnpm-lock.yaml' ? beforeVideo(input) : rawRead(input));
	return input => {
		const bytes = readFile(input);
		if (!affected.has(input)) return bytes;
		const proof = readFile(path);
		assert.equal(sha(proof), seal, 'image ingest dependency predecessor seal');
		const record = JSON.parse(proof);
		assert.equal(record.baseRevision, 'b13645043cfbf422faefa6a2703540d1c8414269');
		assert.deepEqual(Object.keys(record.files), [...affected]);
		const predecessor = record.files[input];
		assert.equal(sha(bytes), predecessor.currentSha256, `image ingest measured current input drift: ${input}${input === 'pnpm-lock.yaml' ? ' (exact historical lock identity)' : ''}`);
		let previous = predecessor.previous;
		if (input === 'pnpm-lock.yaml') {
			previous = bytes.toString();
			for (const patch of [...predecessor.changes].reverse()) {
				assert.equal(previous.slice(patch.offset, patch.offset + patch.before.length), patch.before, 'image ingest exact historical lock identity: exact patch');
				previous = previous.slice(0, patch.offset) + patch.after + previous.slice(patch.offset + patch.before.length);
			}
		}
		assert.equal(sha(Buffer.from(previous)), predecessor.previousSha256, 'image ingest exact historical lock identity');
		return Buffer.from(previous);
	};
}
