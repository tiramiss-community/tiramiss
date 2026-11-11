/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const read = file => readFileSync(new URL(file, root), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = () => JSON.parse(read(directory + 'local-actor-tags-runtime-evidence.json'));

function measuredFile(value, file) {
	const binding = value.files[file];
	assert(binding.validatedBy.length > 0, 'tag file needs actual validation');
	for (const id of binding.validatedBy) {
		const run = value.measurements[id];
		assert.equal(run?.outcome, 'PASS', 'tag actual successful measurement');
		assert.equal(run.exitCode, 0);
		assert.equal(run.failed, 0);
		assert.equal(run.skipped, 0);
		assert(run.passed > 0);
		assert(run.command && run.startedAt && run.finishedAt, 'tag actual run provenance');
		assert.match(run.artifactSha256, /^[a-f0-9]{64}$/);
	}
	return binding;
}

// Extend the existing identity chain; never replace a historical receipt or its run counts.
export function localActorTagDigest(file, previousDigest, label = 'local actor tags previous identity') {
	const value = receipt();
	if (!value.files[file]) return previousDigest;
	const binding = measuredFile(value, file);
	assert(binding.previousSha256.includes(previousDigest) || binding.sha256 === previousDigest, label);
	return binding.sha256;
}

export function validateLocalActorTagEvidence(value, readFile = read) {
	assert.equal(value.scope, 'local-actor-tag-publication');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false);
	assert.equal(value.upstreamHttpMeasured, false);
	assert.equal(value.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	assert.equal(sha(readFile(directory + 'local-actor-tags-observations.json')), value.observationsSha256);
	assert.equal(sha(readFile(directory + 'local-actor-tags-source-probe.mjs')), value.probeSha256);
	for (const [file, digest] of Object.entries(value.historicalSha256)) {
		assert.equal(sha(readFile(file)), digest, 'historic actor tag predecessor preserved');
	}
	for (const id of ['focused-unit', 'integration', 'full-unit']) {
		const run = value.measurements[id];
		assert.equal(run?.outcome, 'PASS', 'required actual tag run');
		assert.equal(run.exitCode, 0);
		assert.equal(run.failed, 0);
		assert.equal(run.skipped, 0);
		assert(run.passed > 0);
	}
	for (const [file, binding] of Object.entries(value.files)) {
		measuredFile(value, file);
		assert.equal(sha(readFile(file)), binding.sha256, 'actual frozen tag input drift');
	}
	assert.match(value.brokerReceiptSha256, /^[a-f0-9]{64}$/);
	assert.match(value.frozenInputMapSha256, /^[a-f0-9]{64}$/);
}
