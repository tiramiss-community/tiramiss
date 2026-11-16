/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPreConnectCheckPackageReader } from './connect-check-package-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const packagePath = 'packages/backend-next/package.json';
const proofPath = 'docs/superpowers/compatibility/connect-check/package-predecessor.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('connect check projects exactly one script into the existing measured video package and passes unrelated inputs through', () => {
	const reader = createPreConnectCheckPackageReader(read);
	assert.equal(sha(reader(packagePath)), '8eae5596313821fb81aeaf01d7e5ae93be9204a48f9323621f23390710746ad8');
	assert.deepEqual(reader('pnpm-lock.yaml'), read('pnpm-lock.yaml'));
});
for (const path of [packagePath, proofPath]) {
	test(`connect check refuses live input and subsequent drift: ${path}`, () => {
		let drift = false;
		const reader = createPreConnectCheckPackageReader(p => drift && p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p));
		reader(packagePath);
		drift = true;
		assert.throws(() => reader(packagePath), /seal|measured current input drift/);
	});
}
