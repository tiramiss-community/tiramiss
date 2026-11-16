/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const packagePath = 'packages/backend-next/package.json';
const proofPath = 'docs/superpowers/compatibility/cli/package-predecessor.json';
const seal = '8b73c439e2e508d9a7a5bf91a7f3452759dd867abe0c7d28363941800eff4922';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// This terminal hop restores one measured script addition. Historical package
// and lock receipts are validated by their original readers after this hop.
export function createPreCliPackageReader(readFile) {
	return path => {
		const bytes = readFile(path);
		if (path !== packagePath) {
			return bytes;
		}
		const proof = readFile(proofPath);
		assert.equal(sha(proof), seal, 'CLI package predecessor seal');
		const record = JSON.parse(proof);
		assert.equal(record.baseRevision, '5f0549ad96af7ce85e12fdcc4bf26f23b029d29d');
		assert.equal(record.path, packagePath);
		assert.equal(sha(bytes), record.currentSha256, 'CLI measured current input drift: packages/backend-next/package.json');
		const current = bytes.toString();
		assert.equal(current.split(record.remove).length, 2, 'CLI package exact script anchor');
		const previous = Buffer.from(current.replace(record.remove, ''));
		assert.equal(sha(previous), record.previousSha256, 'CLI exact historical package identity');
		return previous;
	};
}
