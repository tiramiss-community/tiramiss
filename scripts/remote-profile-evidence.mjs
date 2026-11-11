/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { actorImageRemovalDigest } from './actor-image-removal-evidence.mjs';
import { currentLocalActorImagesDigest as localActorImagesDigest } from './local-actor-images-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const read = file => readFileSync(new URL(file, root));
const readIfAvailable = file => {
	try { return readFileSync(file); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
export const remoteProfileSha = value => createHash('sha256').update(value).digest('hex');

export function validateRootVerification(value, readOptional = readIfAvailable) {
	assert.match(value.receiptSha256, /^[a-f0-9]{64}$/);
	assert(value.receipt);
	const bytes = readOptional(value.receipt);
	if (bytes !== null) {
		assert.equal(remoteProfileSha(bytes), value.receiptSha256, 'root receipt bytes');
		const actual = JSON.parse(bytes);
		assert.equal(actual.status, 'PASS');
		assert.equal(actual.node, value.node);
		assert.equal(actual.completedAt, value.completedAt);
		assert.deepEqual(actual.checks, value.checks, 'root receipt checks');
	}
	for (const check of value.checks) {
		assert.equal(check.status, 'PASS');
		if (!check.log) continue;
		assert.match(check.sha256, /^[a-f0-9]{64}$/);
		const log = readOptional(check.log);
		if (log !== null) assert.equal(remoteProfileSha(log), check.sha256, 'root log bytes');
	}
}

function successfulRun(value, id) {
	const run = value.measurements[id];
	assert.equal(run?.outcome, 'PASS', 'profile actual successful measurement');
	assert.equal(run.exitCode, 0);
	assert(run.command && run.startedAt && run.finishedAt, 'profile actual run provenance');
	assert.match(run.artifactSha256, /^[a-f0-9]{64}$/);
	if (id === 'focused-unit' || id === 'integration') {
		assert(run.passed > 0);
		assert.equal(run.failed, 0);
		assert.equal(run.skipped, 0);
	}
	return run;
}
function measuredFile(value, file) {
	const binding = value.files[file];
	assert(binding.validatedBy.length > 0, 'profile file needs actual validation');
	for (const id of binding.validatedBy) successfulRun(value, id);
	return binding;
}

// Add one measured identity hop after local actor tags; historical receipts stay intact.
export function remoteProfileDigest(file, previousDigest, label = 'remote profile previous identity') {
	const value = JSON.parse(read(directory + 'remote-profile-runtime-evidence.json'));
	if (!value.files[file]) return localActorImagesDigest(file, actorImageRemovalDigest(file, previousDigest, label), label);
	const binding = measuredFile(value, file);
	assert(binding.previousSha256.includes(previousDigest) || binding.sha256 === previousDigest, label);
	return localActorImagesDigest(file, actorImageRemovalDigest(file, binding.sha256, label), label);
}

export function validateRemoteProfileEvidence(value, readFile = read) {
	assert.equal(value.scope, 'public-remote-mention-profile-conversion');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false);
	assert.equal(value.upstreamHttpMeasured, false);
	assert.equal(value.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	for (const id of ['build', 'typecheck', 'focused-unit', 'integration', 'source-probe']) successfulRun(value, id);
	for (const [file, digest] of Object.entries(value.historicalSha256)) {
		assert.equal(remoteProfileSha(readFile(file)), digest, 'historic profile predecessor preserved');
	}
	assert.equal(remoteProfileSha(readFile(directory + 'remote-profile-observations.json')), value.observationsSha256);
	assert.equal(remoteProfileSha(readFile(directory + 'remote-profile-source-probe.mjs')), value.probeSha256);
	for (const [file, binding] of Object.entries(value.files)) {
		measuredFile(value, file);
		assert.equal(value.frozenInputSha256[file], binding.sha256, 'profile binding was frozen');
		assert.equal(remoteProfileSha(readFile(file)), localActorImagesDigest(file, actorImageRemovalDigest(file, binding.sha256)), 'actual frozen profile input drift');
	}
	assert.equal(remoteProfileSha(JSON.stringify(value.frozenInputSha256)), value.frozenInputMapSha256);
	assert.match(value.brokerReceiptSha256, /^[a-f0-9]{64}$/);
	validateRootVerification(value.rootVerification);
}
