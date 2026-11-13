/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { packageImportsDigest, packageImportsPath, validatePackageImportsEvidence } from './package-imports-evidence.mjs';
import { metadataDigest } from './instance-metadata-evidence.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const evidencePath = 'docs/superpowers/compatibility/backend-inventory/package-imports-current-evidence.json';
const evidence = () => JSON.parse(read(evidencePath));

test('package import identity is renewed by the successful full-unit measurement', () => {
	const value = evidence();
	const current = value.inputSha256[packageImportsPath];
	assert.equal(packageImportsDigest(packageImportsPath, value.previousSha256), current);
	assert.equal(packageImportsDigest(packageImportsPath, current), current);
	assert.equal(metadataDigest(packageImportsPath, value.previousSha256), current);
});

test('unrelated identities pass through without reading package evidence', () => {
	assert.equal(packageImportsDigest('unrelated.ts', 'previous', () => { throw new Error('unexpected read'); }), 'previous');
});

test('unknown package import predecessors reject', () => {
	assert.throws(() => packageImportsDigest(packageImportsPath, '0'.repeat(64)), /package import predecessor/);
});

test('unmeasured package import bytes reject', () => {
	assert.throws(() => packageImportsDigest(packageImportsPath, evidence().previousSha256, path => path === packageImportsPath ? Buffer.from('unmeasured') : read(path)), /package import measured input/);
});

test('failed unit measurements cannot renew package imports', () => {
	const value = evidence();
	value.measurement.tests.numFailedTests = 1;
	assert.throws(() => validatePackageImportsEvidence(value), /package import successful tests/);
});

test('a stale entity count cannot renew package imports', () => {
	const value = evidence();
	value.entityCount = 37;
	assert.throws(() => validatePackageImportsEvidence(value), /package import entity count/);
});

test('available measurement artifacts must match the recorded bytes', () => {
	assert.throws(() => validatePackageImportsEvidence(evidence(), read, () => Buffer.from('tampered')), /package import actual artifact/);
});

test('ephemeral artifacts may be absent without relaxing measured input checks', () => {
	validatePackageImportsEvidence(evidence(), read, () => null);
});
