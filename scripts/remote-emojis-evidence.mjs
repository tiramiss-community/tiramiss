/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { localActorTagDigest } from './local-actor-tags-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const read = file => readFileSync(new URL(file, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');

function measuredFile(receipt, file) {
	const binding = receipt.files[file];
	assert(binding, 'emoji measured file binding');
	assert(binding.validatedBy.length > 0, 'emoji file needs a successful run');
	for (const id of binding.validatedBy) {
		const run = receipt.measurements[id];
		assert.equal(run?.outcome, 'PASS', 'emoji actual successful measurement');
		assert.equal(run.exitCode, 0);
		assert.equal(run.failed, 0);
		assert.equal(run.skipped, 0);
		assert(run.passed > 0);
		assert(run.command && run.startedAt && run.finishedAt, 'emoji actual run provenance');
		assert.match(run.artifactSha256, /^[a-f0-9]{64}$/);
	}
	return binding;
}

// Last hop after historical actor/profile/metadata bindings; those receipts remain immutable.
export function remoteEmojiDigest(file, historicalDigest, label = 'remote emoji previous identity') {
	const receipt = JSON.parse(read(directory + 'remote-emojis-runtime-evidence.json'));
	if (!receipt.files[file]) {
		return localActorTagDigest(file, historicalDigest, label);
	}
	const binding = measuredFile(receipt, file);
	assert(binding.previousSha256.includes(historicalDigest) || binding.sha256 === historicalDigest, label);
	return localActorTagDigest(file, binding.sha256, label);
}

export function validateRemoteEmojiEvidence(receipt, readFile = read) {
	assert.equal(receipt.scope, 'public-remote-mention-actor-emojis');
	assert.equal(receipt.notesCreateStatus, 'partial');
	assert.equal(receipt.postingComplete, false);
	assert.deepEqual(receipt.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	assert.equal(receipt.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	for (const [file, digest] of Object.entries(receipt.historicalSha256)) {
		assert.equal(sha(readFile(file)), digest, 'historic emoji predecessor preserved');
	}
	assert.equal(sha(readFile(directory + 'remote-emojis-observations.json')), receipt.observationsSha256);
	assert.equal(sha(readFile(directory + 'remote-emojis-source-probe.mjs')), receipt.probeSha256);
	for (const id of ['integration', 'process', 'full-unit']) {
		assert(receipt.measurements[id], 'required actual runtime run');
	}
	for (const [file, binding] of Object.entries(receipt.files)) {
		measuredFile(receipt, file);
		assert.equal(sha(readFile(file)), localActorTagDigest(file, binding.sha256), 'actual frozen emoji input drift');
	}
	assert.match(receipt.brokerReceiptSha256, /^[a-f0-9]{64}$/);
	assert.match(receipt.frozenInputMapSha256, /^[a-f0-9]{64}$/);
}
