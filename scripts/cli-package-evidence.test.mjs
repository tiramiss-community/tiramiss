/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPreCliPackageReader } from './cli-package-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const packagePath = 'packages/backend-next/package.json';
test('restores only the measured pre-CLI package and passes unrelated inputs through', () => {
	const projected = createPreCliPackageReader(read)(packagePath);
	assert.equal(JSON.parse(projected).scripts.cli, undefined);
	assert.equal(JSON.parse(read(packagePath)).scripts.cli, 'node built/entrypoints/cli.js');
	assert.deepEqual(createPreCliPackageReader(read)('pnpm-lock.yaml'), read('pnpm-lock.yaml'));
});
test('rejects live package drift, proof drift, and drift through a reused reader', () => {
	const mutations = new Map();
	const reader = createPreCliPackageReader(path => mutations.get(path) ?? read(path));
	reader(packagePath);
	mutations.set(packagePath, Buffer.concat([read(packagePath), Buffer.from('\n')]));
	assert.throws(() => reader(packagePath), /measured current input drift/);
	mutations.clear();
	const proof = 'docs/superpowers/compatibility/cli/package-predecessor.json';
	mutations.set(proof, Buffer.concat([read(proof), Buffer.from('\n')]));
	assert.throws(() => reader(packagePath), /CLI package predecessor seal/);
});
