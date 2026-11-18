/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const directory = 'docs/superpowers/compatibility/hashtag-catalog/';
const receiptSeal = '2542d71844117a6618cc75ff9d1c2a2fa91a182fcb62b5a557c5e92ebc147e28';
const predecessorSeal = '40736f8ac99ebb1babb3140c05aa345ce3dcc4c8ca9ed6bbb96ebec71e557e13';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

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

export function validateHashtagCatalogEvidence(readFile = read, optional = optionalRead) {
	const bytes = readFile(directory + 'current-evidence.json');
	assert.equal(sha(bytes), receiptSeal, 'hashtag catalog receipt seal');
	const current = JSON.parse(bytes);
	assert.equal(current.scope, 'hashtag-catalog-495');
	assert.equal(current.measurement, 'R2');
	for (const [path, digest] of Object.entries(current.previousMeasurement.files)) {
		assert.equal(sha(readFile(path)), digest, `hashtag catalog historical input drift: ${path}`);
	}
	assert.equal(current.upstreamFullServerMeasured, false);
	assert.deepEqual(current.inputs, current.inputsAfter);
	for (const [path, digest] of Object.entries(current.inputs)) {
		assert.equal(sha(readFile(path)), digest, `hashtag catalog measured current input drift: ${path}`);
	}
	assert.deepEqual(current.runs.map(run => [run.name, run.passed, run.exitCode]), [['unit', 82, 0], ['http-pg', 58, 0], ['producers-pg', 29, 0], ['source-pg', 53, 0], ['comparison', 5, 0]]);
	for (const run of current.runs) {
		const log = optional(run.log);
		if (log !== null) {
			assert.equal(sha(log), run.logSha256, 'hashtag catalog actual log drift');
		}
	}
	return current;
}

// The old receipts describe their original runs. Remove only the two exact
// catalog registrations; any other bytes continue to the older drift checks.
export function projectHashtagCatalogInput(path, actual, readFile = read) {
	if (path !== 'packages/backend-next/src/composition/http-app.ts' && path !== 'packages/backend-next/test/unit/composition/http-app.test.ts') {
		return actual;
	}
	const bytes = readFile(directory + 'predecessor.json');
	assert.equal(sha(bytes), predecessorSeal, 'hashtag catalog predecessor seal');
	const record = JSON.parse(bytes);
	const binding = Object.hasOwn(record.files, path) ? record.files[path] : undefined;
	if (!binding || sha(actual) !== binding.currentSha256) {
		return actual;
	}
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const insert = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'hashtag catalog exact predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'hashtag catalog exact predecessor identity');
	return before;
}
