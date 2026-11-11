/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { localActorImagesDigest } from './local-actor-images-evidence.mjs';
const root = new URL('../', import.meta.url);
const evidencePath = 'docs/superpowers/compatibility/remote-user/actor-image-removal-current-evidence.json';
const read = file => readFileSync(new URL(file, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readOptional = file => {
	try { return readFileSync(file); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
const requiredRuns = ['build', 'typecheck', 'unit', 'integration', 'source'];

// This pin attests the extracted subset, predecessor identities and actual receipt
// together, so CI does not depend on the parent's ephemeral /tmp artifacts.
const reviewedRecordSha256 = '88b0692a06e0f576390f893bf18dbced4e56327eb425bb072943890545f66577';

export function validateActorImageRemovalEvidence(value, readFile = read, optional = readOptional) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'actor-image-removal-identity-renewal');
	assert.equal(value.postingComplete, false, 'posting remains partial');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.upstreamHttpMeasured, false);
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS');
	assert.equal(receipt.frozenInputs, 517, 'frozen request count');
	assert.equal(receipt.requestSha256, value.request.sha256);
	assert.equal(receipt.requestPath, value.request.path);
	assert.equal(receipt.base, value.request.base);
	assert.equal(value.request.status, 'FROZEN_READY');
	assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt), 'actual renewal timestamps');
	assert.deepEqual(receipt.commands.map(c => c.id), requiredRuns, 'successful renewal run');
	for (const id of requiredRuns) {
		const run = receipt.commands.find(c => c.id === id);
		assert(run && run.exitCode === 0 && run.command && run.log, 'successful renewal run');
		assert.match(run.logSha256, /^[a-f0-9]{64}$/);
		if (id === 'unit' || id === 'integration') {
			const tests = run.tests;
			assert(tests?.success && tests.numTotalTests === tests.numPassedTests && tests.numPassedTests > 0 && tests.numFailedTests === 0 && tests.numPendingTests === 0, 'successful selected tests');
			assert.match(run.artifactSha256, /^[a-f0-9]{64}$/);
		}
	}
	for (const [file, binding] of Object.entries(value.files)) {
		assert.deepEqual(binding.validatedBy, requiredRuns, 'relevant renewal runs');
		assert.equal(binding.sha256, value.frozenInputSha256[file], 'renewal binding was frozen');
		assert.equal(sha(readFile(file)), localActorImagesDigest(file, binding.sha256, 'renewal previous identity', readFile, optional), 'renewal measured input drift');
	}
	for (const binding of [value.historicalEvidence, value.predecessorEvidence]) {
		assert.equal(sha(readFile(binding.path)), binding.sha256, 'renewal historical evidence drift');
	}
	const historic = JSON.parse(readFile(value.historicalEvidence.path));
	assert.equal(historic.receipt.sha256, value.receipt.sha256);
	assert.equal(historic.receipt.requestSha256, value.request.sha256);
	assert.deepEqual(historic.commands, receipt.commands);
	assert.deepEqual(historic.runtime, receipt.runtime);
	assert.equal(historic.base, receipt.base);
	for (const key of ['request', 'receipt']) {
		const binding = value[key];
		const bytes = optional(binding.path);
		if (bytes === null) continue;
		assert.equal(sha(bytes), binding.sha256, `actual renewal ${key} bytes`);
		const actual = JSON.parse(bytes);
		if (key === 'receipt') {
			assert.deepEqual(actual, receipt, 'actual renewal receipt data');
		} else {
			assert.equal(actual.status, value.request.status);
			assert.equal(actual.base, receipt.base);
			assert.equal(Object.keys(actual.sha256).length, receipt.frozenInputs);
			for (const [file, digest] of Object.entries(value.frozenInputSha256)) {
				assert.equal(actual.sha256[value.request.root + file], digest, 'actual renewal frozen subset');
			}
		}
	}
	for (const run of receipt.commands) {
		for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
			if (!path) continue;
			const bytes = optional(path);
			if (bytes !== null) assert.equal(sha(bytes), digest, 'actual renewal run bytes');
		}
	}
	assert.equal(sha(JSON.stringify(value)), reviewedRecordSha256, 'reviewed renewal record');
}

export function actorImageRemovalDigest(file, previousDigest, label = 'actor image removal previous identity') {
	const value = JSON.parse(read(evidencePath));
	const binding = value.files[file];
	if (!binding) return previousDigest;
	// Preserve callers' predecessor error contracts before inspecting the new hop.
	assert(binding.previousSha256 === previousDigest || binding.sha256 === previousDigest, label);
	validateActorImageRemovalEvidence(value);
	return binding.sha256;
}
