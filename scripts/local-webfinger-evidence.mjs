/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-webfinger-current-evidence.json';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalMap = map => JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const optionalRead = path => {
	try { return readFileSync(path); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
const file = 'packages/backend-next/src/modules/federation/public.ts';
const predecessorPath = directory + 'local-actor-images-current-evidence.json';
const predecessorSha256 = 'c31ad9b0e20c7c07829d2a205f9c9c8b8cf52110e41dae75432241f262fa5553';
const predecessorCanonicalSha256 = '1e3ddeef85c441ed5ba0f4f9ad953414eb9559f7525a430f3bcddba5124fc326';
const previousSha256 = 'd2d971b30cf383c5e273337f9dbf131fb5f7c4a773ffa07e3434011ffa1ae5ac';
const consumerFile = 'packages/backend-next/test/unit/composition/http-app.test.ts';
const consumerPreviousSha256 = 'a1b3612237d5de33cf8f20d7df16bc5ddb69db97b1b399c7f7b6a005440d995a';
const consumerPredecessor = { path: directory + 'actor-instance-registration-runtime-evidence.json', sha256: 'd36d75bb0a90670c37ffbe0275562fe2d74f5e98e6c5fffe3069b36401919828' };
const requiredRuns = ['build', 'typecheck', 'units', 'webfinger-integration', 'source-check', 'shipping'];
const applicableRuns = ['build', 'typecheck', 'units', 'webfinger-integration'];
// A single reviewed binding pins the measured R2 record; no ephemeral host file is required in CI.
const reviewedRecordSha256 = '7ec74324ed0b9c0fa49159238463acbe7e097ce322a23d64985e20c5ca4ebb32';

export function validateLocalWebfingerEvidence(value, readFile = read, optional = optionalRead) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'local-webfinger-single-identity-hop');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false, 'posting remains partial');
	assert.equal(value.upstreamFullServerMeasured, false, 'source is not full server');
	assert.equal(value.file, file, 'WebFinger single identity');
	assert.equal(value.previousSha256, previousSha256, 'WebFinger predecessor identity');
	assert.deepEqual(value.predecessor, { path: predecessorPath, sha256: predecessorSha256, canonicalSha256: predecessorCanonicalSha256 }, 'WebFinger predecessor identity');
	const predecessorBytes = readFile(predecessorPath);
	assert.equal(sha(predecessorBytes), predecessorSha256, 'WebFinger predecessor drift');
	const predecessor = JSON.parse(predecessorBytes);
	assert.equal(sha(JSON.stringify(predecessor)), predecessorCanonicalSha256, 'WebFinger predecessor drift');
	assert.equal(predecessor.files[file].sha256, value.previousSha256, 'WebFinger predecessor identity');
	assert.notEqual(value.sha256, value.previousSha256, 'WebFinger finite hop');
	assert.equal(value.frozenInputSha256[file], value.sha256, 'WebFinger frozen identity');
	assert.deepEqual(value.validatedBy, applicableRuns, 'WebFinger applicable runs');
	const consumer = value.consumerRenewal;
	assert.equal(consumer.file, consumerFile, 'WebFinger consumer identity');
	assert.equal(consumer.previousSha256, consumerPreviousSha256, 'WebFinger consumer predecessor identity');
	assert.deepEqual(consumer.predecessor, consumerPredecessor, 'WebFinger consumer predecessor identity');
	const consumerHistoryBytes = readFile(consumerPredecessor.path);
	assert.equal(sha(consumerHistoryBytes), consumerPredecessor.sha256, 'WebFinger consumer history drift');
	assert.equal(JSON.parse(consumerHistoryBytes).measurements['full-unit'].sourceSha256[consumerFile], consumer.previousSha256, 'WebFinger consumer predecessor identity');
	assert.equal(value.frozenInputSha256[consumer.file], consumer.sha256, 'WebFinger consumer frozen identity');
	assert.deepEqual(consumer.validatedBy, ['units'], 'WebFinger consumer applicable runs');
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS', 'WebFinger successful run');
	assert.deepEqual(receipt.commands.map(c => c.id), requiredRuns, 'WebFinger required runs');
	for (const run of receipt.commands) {
		assert(run.exitCode === 0 && run.command && run.log, 'WebFinger successful run');
		assert.match(run.logSha256, /^[a-f0-9]{64}$/);
		if (['units', 'webfinger-integration'].includes(run.id)) {
			const tests = run.tests;
			assert(tests?.success && tests.numTotalTests === tests.numPassedTests && tests.numPassedTests > 0 && tests.numFailedTests === 0 && tests.numPendingTests === 0, 'WebFinger successful tests');
			assert(run.artifact && /^[a-f0-9]{64}$/.test(run.artifactSha256), 'WebFinger test artifact');
		}
	}
	assert.equal(value.request.status, 'FROZEN_READY', 'WebFinger frozen request');
	assert.equal(receipt.requestPath, value.request.path, 'WebFinger request binding');
	assert.equal(receipt.requestSha256, value.request.sha256, 'WebFinger request binding');
	assert.equal(receipt.base, value.request.base, 'WebFinger request binding');
	assert.equal(receipt.frozenInputs, 846, 'WebFinger frozen count');
	assert.equal(value.request.frozenInputs, 846, 'WebFinger frozen count');
	assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt), 'WebFinger measurement window');
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
		assert.equal(sha(readFile(path)), digest, 'WebFinger measured input drift');
	}
	for (const binding of [value.runtimeEvidence, value.sourceEvidence]) {
		assert.equal(sha(readFile(binding.path)), binding.sha256, 'WebFinger historical evidence drift');
	}
	const runtime = JSON.parse(readFile(value.runtimeEvidence.path));
	assert.equal(runtime.brokerReceiptSha256, value.receipt.sha256, 'WebFinger receipt binding');
	assert.equal(runtime.brokerRequestSha256, value.request.sha256, 'WebFinger request binding');
	assert.deepEqual(runtime.measurements, receipt.commands, 'WebFinger measured runs');
	assert.deepEqual(runtime.runtime, receipt.runtime, 'WebFinger runtime binding');
	assert.deepEqual(runtime.measurementWindow, { startedAt: receipt.startedAt, completedAt: receipt.completedAt });
	assert.equal(runtime.frozenInputCount, 846);
	assert.equal(Object.keys(runtime.frozenInputSha256).length, 846);
	assert.equal(sha(canonicalMap(runtime.frozenInputSha256)), value.request.frozenInputMapSha256, 'WebFinger frozen map');
	assert.equal(runtime.frozenInputMapSha256, value.request.frozenInputMapSha256, 'WebFinger frozen map');
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
		assert.equal(runtime.frozenInputSha256[path], digest, 'WebFinger frozen identity');
	}
	const observations = JSON.parse(readFile(directory + 'local-webfinger-observations.json'));
	assert.equal(observations.cases.length, value.sourceOracle.caseCount, 'WebFinger source binding');
	assert.equal(value.sourceOracle.caseCount, 49, 'WebFinger source binding');
	assert.deepEqual(observations.manifest, value.sourceOracle.sourceManifest, 'WebFinger source binding');
	assert.deepEqual(observations.doubles, value.sourceOracle.doubles, 'WebFinger source binding');
	assert.equal(observations.errorBodyScope, value.sourceOracle.errorBodyScope, 'WebFinger source binding');
	assert.equal(sha(readFile(directory + 'local-webfinger-corpus.json')), observations.corpusSha256, 'WebFinger source corpus drift');
	assert.deepEqual(JSON.parse(readFile(value.sourceEvidence.path)).source, value.sourceOracle, 'WebFinger source binding');
	for (const key of ['request', 'receipt']) {
		const binding = value[key];
		const bytes = optional(binding.path);
		if (bytes === null) continue;
		assert.equal(sha(bytes), binding.sha256, `WebFinger actual ${key} bytes`);
		const actual = JSON.parse(bytes);
		if (key === 'receipt') {
			assert.deepEqual(actual, receipt, 'WebFinger actual receipt data');
		} else {
			assert.equal(actual.status, value.request.status);
			assert.equal(actual.base, receipt.base);
			assert.deepEqual(actual.sha256, runtime.frozenInputSha256, 'WebFinger actual frozen map');
			assert.deepEqual(actual.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]), receipt.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]));
		}
	}
	for (const run of receipt.commands) {
		for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
			if (!path) continue;
			const bytes = optional(path);
			if (bytes === null) continue;
			assert.equal(sha(bytes), digest, 'WebFinger actual run bytes');
			if (path === run.artifact) {
				const actual = JSON.parse(bytes);
				assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'WebFinger actual test results');
			}
		}
	}
	assert.equal(sha(JSON.stringify(value)), reviewedRecordSha256, 'WebFinger reviewed record');
}

export function localWebfingerDigest(path, previousDigest, readFile = read, optional = optionalRead) {
	if (path !== file && path !== consumerFile) return previousDigest;
	const value = JSON.parse(readFile(evidencePath));
	const binding = path === file ? value : value.consumerRenewal;
	const previous = path === file ? previousSha256 : consumerPreviousSha256;
	assert(previousDigest === previous || previousDigest === binding.sha256, 'WebFinger previous identity');
	validateLocalWebfingerEvidence(value, readFile, optional);
	return binding.sha256;
}
