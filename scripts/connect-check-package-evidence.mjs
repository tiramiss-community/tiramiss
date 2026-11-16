/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const packagePath = 'packages/backend-next/package.json';
const proofPath = 'docs/superpowers/compatibility/connect-check/package-predecessor.json';
const seal = 'f2a56c988c6e075abc439947ccefa50fb20cee09d41b06cbad0030eb18dff5a1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function createPreConnectCheckPackageReader(readFile) {
	return path => {
		const bytes = readFile(path);
		if (path !== packagePath) {
			return bytes;
		}
		const proof = readFile(proofPath);
		assert.equal(sha(proof), seal, 'connect check package predecessor seal');
		const record = JSON.parse(proof);
		assert.equal(record.baseRevision, '8c3f6d51e17a2a2f73c2f2156a384c2519ca21c5');
		assert.equal(record.path, packagePath);
		assert.equal(sha(bytes), record.currentSha256, 'video ingest measured current input drift: packages/backend-next/package.json (connect check successor)');
		const current = bytes.toString();
		assert.equal(current.split(record.remove).length, 2, 'connect check exact script anchor');
		const previous = Buffer.from(current.replace(record.remove, ''));
		assert.equal(sha(previous), record.previousSha256, 'connect check exact historical package identity');
		return previous;
	};
}
