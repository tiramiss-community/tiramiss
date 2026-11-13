/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const evidencePath = 'docs/superpowers/compatibility/backend-inventory/package-imports-current-evidence.json';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = '0af0eab138933f819193cd77f2a063bc600905fcd926cc8b4388253ef6053d4b';
const canonical = '7963787fa74a5b66a90eff2af0533c65ceab3d166d93444283739e0625df4a14';
const optionalRead = path => {
	try {
		return readFileSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
};
export const packageImportsPath = 'packages/backend-next/test/package-imports.test.ts';

export function validatePackageImportsEvidence(value, readFile = read, optional = optionalRead) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'package-imports-38-entities');
	assert.equal(value.entityCount, 38, 'package import entity count');
	assert.equal(value.previousSha256, previous, 'package import predecessor');
	assert.deepEqual(Object.keys(value.inputSha256).sort(), [packageImportsPath, ...['src/models/UserNotePining.ts', 'upstream-sync.json', 'exports/entities.ts', '.managed-files.json'].map(path => 'packages/backend-upstream/' + path)].sort());
	for (const [path, digest] of Object.entries(value.inputSha256)) {
		assert.equal(sha(readFile(path)), digest, 'package import measured input');
	}
	const run = value.measurement;
	assert.equal(run.exitCode, 0, 'package import successful measurement');
	assert.deepEqual(run.tests, { numTotalTests: 3403, numPassedTests: 3403, numFailedTests: 0, numPendingTests: 0, success: true }, 'package import successful tests');
	assert.deepEqual(run.command, ['pnpm', '--filter', 'backend-next', 'test', '--reporter=json', '--outputFile=/tmp/tiramiss-pr270-ci-full-unit.json']);
	assert(Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.completedAt) >= Date.parse(run.startedAt));
	assert.equal(sha(JSON.stringify(value)), canonical, 'package import evidence identity');
	for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
		const bytes = optional(path);
		if (bytes === null) {
			continue;
		}
		assert.equal(sha(bytes), digest, 'package import actual artifact');
		if (path === run.artifact) {
			const actual = JSON.parse(bytes);
			assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'package import actual test results');
		}
	}
}

// Only this test's measured identity changes; earlier runtime receipts retain their bytes.
export function packageImportsDigest(file, oldDigest, readFile = read, optional = optionalRead) {
	if (file !== packageImportsPath) {
		return oldDigest;
	}
	const value = JSON.parse(readFile(evidencePath));
	assert(oldDigest === previous || oldDigest === value.inputSha256[file], 'package import predecessor');
	validatePackageImportsEvidence(value, readFile, optional);
	return value.inputSha256[file];
}
