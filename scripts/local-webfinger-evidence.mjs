/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { localActorFieldsDigest, currentLocalActorFieldsDigest } from './local-actor-fields-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-webfinger-current-evidence.json';
const read = path => readPreAliasKey(path);
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
const r2CurrentPath = directory + 'local-webfinger-r2-current-evidence.json';
const r2CurrentSha256 = 'af63941a3bf606be9c7fb2b075a1d6da32fa06ffd41b5c4550cacb23db34b925';
const r2CurrentCanonicalSha256 = '7ec74324ed0b9c0fa49159238463acbe7e097ce322a23d64985e20c5ca4ebb32';
const r3Prefix = '/tmp/tiramiss-s1-r10-validation-r3-';
const sourceProbePath = directory + 'local-webfinger-source-probe.mjs';
const sourceProbePreviousSha256 = '758b3e79c87329ffabe33e0ba1976506885f16f3739bffa84b7585b82289947b';
// Pins R3 provenance, its R2 archive and the separate probe correction; host files are optional in CI.
const reviewedRecordSha256 = '5cfc3683614178b90531901018bca75e0c67e3e3faca8421becbc11cc5c7e175';

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
	const history = value.previousCurrentRecord;
	assert.equal(history.path, r2CurrentPath, 'WebFinger R2 archive identity');
	assert.equal(history.sha256, r2CurrentSha256, 'WebFinger R2 archive identity');
	assert.equal(history.canonicalSha256, r2CurrentCanonicalSha256, 'WebFinger R2 archive identity');
	const r2Bytes = readFile(r2CurrentPath);
	assert.equal(sha(r2Bytes), r2CurrentSha256, 'WebFinger R2 archive drift');
	const r2 = JSON.parse(r2Bytes);
	assert.equal(sha(JSON.stringify(r2)), r2CurrentCanonicalSha256, 'WebFinger R2 archive drift');
	assert.equal(r2.file, value.file, 'WebFinger R2 archive identity');
	assert.equal(r2.previousSha256, value.previousSha256, 'WebFinger R2 archive identity');
	assert.equal(r2.sha256, value.sha256, 'WebFinger R2 export identity');
	assert.equal(r2.consumerRenewal.file, consumer.file, 'WebFinger R2 archive identity');
	assert.equal(r2.consumerRenewal.previousSha256, consumer.previousSha256, 'WebFinger R2 archive identity');
	assert.equal(r2.runtimeEvidence.path, directory + 'local-webfinger-logging-runtime-evidence.json', 'WebFinger R2 archive identity');
	assert.equal(sha(readFile(r2.runtimeEvidence.path)), r2.runtimeEvidence.sha256, 'WebFinger R2 runtime drift');
	assert.equal(r2.sourceEvidence.sha256, value.sourceEvidence.sha256, 'WebFinger R2 source identity');
	assert.deepEqual(Object.keys(value.frozenInputSha256).sort(), Object.keys(r2.frozenInputSha256).sort(), 'WebFinger relevant subset');
	assert.equal(Object.keys(value.frozenInputSha256).length, 14, 'WebFinger relevant subset');
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS', 'WebFinger successful run');
	assert.deepEqual(receipt.commands.map(c => c.id), requiredRuns, 'WebFinger required runs');
	for (const run of receipt.commands) {
		assert(run.exitCode === 0 && run.command && run.log, 'WebFinger successful run');
		assert.match(run.logSha256, /^[a-f0-9]{64}$/);
		assert.equal(run.log, `${r3Prefix}${run.id}.log`, 'WebFinger R3 run path');
		if (['units', 'webfinger-integration'].includes(run.id)) {
			const tests = run.tests;
			assert(tests?.success && tests.numTotalTests === tests.numPassedTests && tests.numPassedTests > 0 && tests.numFailedTests === 0 && tests.numPendingTests === 0, 'WebFinger successful tests');
			assert.equal(tests.numTotalTests, run.id === 'units' ? 235 : 46, 'WebFinger successful tests');
			assert(run.artifact && /^[a-f0-9]{64}$/.test(run.artifactSha256), 'WebFinger test artifact');
			assert.equal(run.artifact, `${r3Prefix}${run.id}.json`, 'WebFinger test artifact');
		}
	}
	assert.equal(value.request.status, 'FROZEN_READY', 'WebFinger frozen request');
	assert.equal(value.request.path, '/tmp/tiramiss-s1-r10-validation-request-r3.json', 'WebFinger R3 request path');
	assert.equal(value.receipt.path, '/tmp/tiramiss-s1-r10-validation-receipt-r3.json', 'WebFinger R3 receipt path');
	assert.equal(receipt.requestPath, value.request.path, 'WebFinger request binding');
	assert.equal(receipt.requestSha256, value.request.sha256, 'WebFinger request binding');
	assert.equal(receipt.base, value.request.base, 'WebFinger request binding');
	assert.equal(receipt.frozenInputs, 846, 'WebFinger frozen count');
	assert.equal(value.request.frozenInputs, 846, 'WebFinger frozen count');
	assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt), 'WebFinger measurement window');
	// Only the source probe changed after R3; its separate replay does not renew product measurements.
	const correction = value.sourceProbeCorrection;
	assert.equal(correction.scope, 'webfinger-meta-fault-probe-only', 'WebFinger source probe correction scope');
	assert.equal(correction.path, sourceProbePath, 'WebFinger source probe correction scope');
	assert.equal(correction.previousSha256, sourceProbePreviousSha256, 'WebFinger source probe predecessor');
	assert.equal(value.frozenInputSha256[sourceProbePath], sourceProbePreviousSha256, 'WebFinger source probe predecessor');
	assert.match(correction.sha256, /^[a-f0-9]{64}$/);
	assert.equal(correction.run.exitCode, 0, 'WebFinger successful source probe replay');
	assert.equal(correction.run.caseCount, 49, 'WebFinger source probe case count');
	assert.equal(correction.run.command, `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node ${sourceProbePath} --check`, 'WebFinger source probe replay command');
	assert.deepEqual(correction.run.metaFaultControl, { optionsStatus: 204, optionsMetaReads: 0, getStatus: 500, getMetaReads: 1, userLookups: 0 }, 'WebFinger source probe fault controls');
	assert.equal(sha(readFile(directory + 'local-webfinger-observations.json')), correction.observationsSha256, 'WebFinger source probe observations drift');
	assert.equal(sha(readFile(directory + 'local-webfinger-corpus.json')), correction.corpusSha256, 'WebFinger source probe corpus drift');
	assert(Number.isFinite(Date.parse(correction.startedAt)) && Date.parse(correction.completedAt) >= Date.parse(correction.startedAt), 'WebFinger source probe replay window');
	assert.match(correction.run.logSha256, /^[a-f0-9]{64}$/);
	const correctionLog = optional(correction.run.log);
	if (correctionLog !== null) {
		assert.equal(sha(correctionLog), correction.run.logSha256, 'WebFinger actual source probe log bytes');
	}
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
		assert.equal(sha(readFile(path)), path === sourceProbePath ? correction.sha256 : currentLocalActorFieldsDigest(path, digest, readFile, optional, 'WebFinger measured input drift'), 'WebFinger measured input drift');
	}
	for (const binding of [value.runtimeEvidence, value.sourceEvidence]) {
		assert.equal(sha(readFile(binding.path)), binding.sha256, 'WebFinger historical evidence drift');
	}
	assert.equal(value.runtimeEvidence.path, directory + 'local-webfinger-structured-logging-runtime-evidence.json', 'WebFinger R3 runtime path');
	const runtime = JSON.parse(readFile(value.runtimeEvidence.path));
	assert.equal(runtime.scope, 'local-webfinger-structured-logging', 'WebFinger R3 runtime scope');
	assert.equal(runtime.brokerRequestPath, value.request.path, 'WebFinger request binding');
	assert.equal(runtime.brokerReceiptPath, value.receipt.path, 'WebFinger receipt binding');
	assert.equal(runtime.brokerReceiptSha256, value.receipt.sha256, 'WebFinger receipt binding');
	assert.equal(runtime.brokerRequestSha256, value.request.sha256, 'WebFinger request binding');
	assert.deepEqual(runtime.measurements, receipt.commands, 'WebFinger measured runs');
	assert.deepEqual(runtime.runtime, receipt.runtime, 'WebFinger runtime binding');
	assert.deepEqual(runtime.measurementWindow, { startedAt: receipt.startedAt, completedAt: receipt.completedAt });
	assert.equal(runtime.frozenInputCount, 846);
	assert.equal(Object.keys(runtime.frozenInputSha256).length, 14, 'WebFinger relevant subset');
	assert.deepEqual(runtime.frozenInputSha256, value.frozenInputSha256, 'WebFinger frozen identity');
	assert.match(value.request.frozenInputMapSha256, /^[a-f0-9]{64}$/, 'WebFinger frozen map');
	assert.equal(runtime.frozenInputMapSha256, value.request.frozenInputMapSha256, 'WebFinger frozen map');
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
		assert.equal(runtime.frozenInputSha256[path], digest, 'WebFinger frozen identity');
	}
	assert.deepEqual(runtime.historicalR2CurrentRecord, { path: r2CurrentPath, sha256: r2CurrentSha256, canonicalSha256: r2CurrentCanonicalSha256 }, 'WebFinger R2 archive identity');
	assert.deepEqual(runtime.source, value.sourceOracle, 'WebFinger source binding');
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
			assert.equal(Object.keys(actual.sha256).length, 846, 'WebFinger actual frozen map');
			assert.equal(sha(canonicalMap(actual.sha256)), value.request.frozenInputMapSha256, 'WebFinger actual frozen map');
			for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
				assert.equal(actual.sha256[path], digest, 'WebFinger actual frozen identity');
			}
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
	if (path !== file && path !== consumerFile) return localActorFieldsDigest(path, previousDigest, readFile, optional);
	const value = JSON.parse(readFile(evidencePath));
	const binding = path === file ? value : value.consumerRenewal;
	const previous = path === file ? previousSha256 : consumerPreviousSha256;
	assert(previousDigest === previous || previousDigest === binding.sha256, 'WebFinger previous identity');
	validateLocalWebfingerEvidence(value, readFile, optional);
	return localActorFieldsDigest(path, binding.sha256, readFile, optional);
}

// Existing WebFinger callers retain their R3 identity projection.
export function currentLocalWebfingerDigest(path, previousDigest, readFile = read, optional = optionalRead) {
	return currentLocalActorFieldsDigest(path, localWebfingerDigest(path, previousDigest, readFile, optional), readFile, optional);
}
