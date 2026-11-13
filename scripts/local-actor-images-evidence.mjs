/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { localWebfingerDigest, currentLocalWebfingerDigest } from './local-webfinger-evidence.mjs';
const root = new URL('../', import.meta.url);
const evidencePath = 'docs/superpowers/compatibility/remote-user/local-actor-images-current-evidence.json';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
	try { return readFileSync(path); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
const requiredRuns = ['build', 'typecheck', 'units', 'activitypub-actor-integration', 'remote-user-integration', 'source-check'];
// Pins the finite changed-input subset, measured provenance and real base identities.
const reviewedRecordSha256 = '1e3ddeef85c441ed5ba0f4f9ad953414eb9559f7525a430f3bcddba5124fc326';

export function validateLocalActorImagesEvidence(value, readFile = read, optional = optionalRead) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'local-actor-images-identity-renewal');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false, 'posting remains partial');
	assert.equal(value.upstreamHttpMeasured, false, 'source methods are not upstream HTTP');
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS');
	assert.equal(receipt.base, value.baseCommit);
	assert.equal(receipt.frozenInputs, 835);
	assert.equal(value.request.frozenInputs, 835);
	assert.equal(value.request.status, 'FROZEN_READY');
	assert.equal(receipt.requestPath, value.request.path);
	assert.equal(receipt.requestSha256, value.request.sha256);
	assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt), 'image measurement window');
	assert.deepEqual(receipt.commands.map(c => c.id), requiredRuns, 'required image runs');
	for (const run of receipt.commands) {
		assert(run.exitCode === 0 && run.command && run.log, 'successful image run');
		assert.match(run.logSha256, /^[a-f0-9]{64}$/);
		if (['units', 'activitypub-actor-integration', 'remote-user-integration'].includes(run.id)) {
			const tests = run.tests;
			assert(tests?.success && tests.numTotalTests === tests.numPassedTests && tests.numPassedTests > 0 && tests.numFailedTests === 0 && tests.numPendingTests === 0, 'successful image tests');
			assert.match(run.artifactSha256, /^[a-f0-9]{64}$/);
		}
	}
	for (const [file, binding] of Object.entries(value.files)) {
		assert(binding.validatedBy.length > 0 && binding.validatedBy.every(id => requiredRuns.includes(id)), 'applicable successful run');
		let applicable;
		if (file.startsWith('docs/')) applicable = ['source-check'];
		else if (file.includes('/test/integration/')) applicable = ['activitypub-actor-integration'];
		else if (file.includes('/test/')) applicable = ['units'];
		else if (file.endsWith('platform/database/note-files.ts')) applicable = ['build', 'typecheck', 'units'];
		else if (file.endsWith('modules/drive/public.ts')) applicable = ['build', 'typecheck'];
		else applicable = ['build', 'typecheck', 'activitypub-actor-integration'];
		assert(applicable.every(id => binding.validatedBy.includes(id)), 'applicable successful run');
		assert.equal(binding.sha256, value.frozenInputSha256[file], 'image binding was frozen');
		assert.equal(sha(readFile(file)), currentLocalWebfingerDigest(file, binding.sha256, readFile, optional), 'renewal measured input drift');
	}
	for (const binding of [value.historicalEvidence, value.predecessorEvidence]) {
		assert.equal(sha(readFile(binding.path)), binding.sha256, 'renewal historical evidence drift');
	}
	const historical = JSON.parse(readFile(value.historicalEvidence.path));
	assert.equal(historical.brokerReceiptSha256, value.receipt.sha256);
	assert.equal(historical.brokerRequestSha256, value.request.sha256);
	assert.equal(historical.frozenInputMapSha256, value.request.frozenInputMapSha256, 'historical image frozen map');
	assert.deepEqual(historical.measurements, receipt.commands);
	assert.deepEqual(historical.runtime, receipt.runtime);
	assert.deepEqual(historical.sourceOracle, value.sourceOracle, 'source oracle binding');
	const directory = 'docs/superpowers/compatibility/remote-user/';
	const observations = JSON.parse(readFile(directory + 'local-actor-images-observations.json'));
	assert.equal(observations.upstreamCommit, value.upstreamCommit);
	assert.deepEqual(observations.manifest, value.sourceOracle.manifest, 'source oracle binding');
	assert.equal(observations.corpusSha256, value.sourceOracle.corpusSha256, 'source corpus binding');
	assert.equal(observations.cases.length, value.sourceOracle.cases);
	assert.equal(sha(readFile(directory + 'local-actor-images-corpus.json')), observations.corpusSha256);
	for (const key of ['request', 'receipt']) {
		const binding = value[key];
		const bytes = optional(binding.path);
		if (bytes === null) continue;
		assert.equal(sha(bytes), binding.sha256, `actual image ${key} bytes`);
		const actual = JSON.parse(bytes);
		if (key === 'receipt') {
			assert.deepEqual(actual, receipt);
		} else {
			assert.equal(actual.status, value.request.status);
			assert.equal(actual.base, receipt.base);
			assert.equal(Object.keys(actual.sha256).length, 835);
			const canonicalMap = Object.fromEntries(Object.entries(actual.sha256).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
			assert.equal(sha(JSON.stringify(canonicalMap)), value.request.frozenInputMapSha256, 'actual image frozen map');
			for (const [file, digest] of Object.entries(value.frozenInputSha256)) assert.equal(actual.sha256[file], digest, 'actual image frozen subset');
			assert.deepEqual(actual.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]), receipt.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]));
		}
	}
	for (const run of receipt.commands) {
		for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
			if (!path) continue;
			const bytes = optional(path);
			if (bytes === null) continue;
			assert.equal(sha(bytes), digest, 'actual image run bytes');
			if (path === run.artifact) {
				const actual = JSON.parse(bytes);
				assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'actual image test results');
			}
		}
	}
	assert.equal(sha(JSON.stringify(value)), reviewedRecordSha256, 'reviewed image record');
}

export function localActorImagesDigest(file, previousDigest, label = 'local actor images previous identity', readFile = read, optional = optionalRead) {
	const value = JSON.parse(readFile(evidencePath));
	const binding = value.files[file];
	if (!binding) return previousDigest;
	assert((binding.previousSha256 !== null && binding.previousSha256 === previousDigest) || binding.sha256 === previousDigest, label);
	validateLocalActorImagesEvidence(value, readFile, optional);
	return binding.sha256;
}

// Historical callers retain their pinned digest. Current-byte consumers explicitly
// follow the single WebFinger hop after validating the unchanged image record.
export function currentLocalActorImagesDigest(file, previousDigest, label = 'local actor images previous identity', readFile = read, optional = optionalRead) {
	return localWebfingerDigest(file, localActorImagesDigest(file, previousDigest, label, readFile, optional), readFile, optional);
}

// Current byte checks explicitly opt into featured; the older public projection stays stable.
export function currentFeaturedActorImagesDigest(file, previousDigest, label = 'local actor images previous identity', readFile = read, optional = optionalRead) {
	return currentLocalWebfingerDigest(file, localActorImagesDigest(file, previousDigest, label, readFile, optional), readFile, optional);
}
