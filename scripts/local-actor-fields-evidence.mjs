/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-actor-fields-current-evidence.json';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalMap = map => JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const optionalRead = path => {
	try { return readFileSync(path); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
const renewedFiles = [
	'src/modules/federation/local-actor.ts',
	'src/platform/database/local-actors.ts',
	'test/helpers/local-actor.ts',
	'test/integration/activitypub-actor.test.ts',
	...['actor-api', 'local-actor-images', 'local-actor-profile', 'local-actor-tags', 'local-actor'].map(name => `test/unit/federation/${name}.test.ts`),
].map(path => 'packages/backend-next/' + path);
const measuredFiles = [
	...renewedFiles,
	'packages/backend-next/test/helpers/local-actor-fields.ts',
	'packages/backend-next/test/unit/federation/local-actor-fields.test.ts',
	...['corpus.json', 'observations.json', 'source-probe.mjs'].map(name => directory + 'local-actor-fields-' + name),
].sort();
const requiredRuns = ['sync-check', 'build', 'typecheck', 'units', 'actor-remote-integration', 'source-check', 'shipping'];
// Binds the actual host receipt, finite source/renewal subset and complete input-map
// hash together. CI can verify this record without retaining ephemeral host files.
const canonicalRecordSha256 = '8f6e5e68dd2cbb12a93377de461ab2111aeb922472cb8baf57158d0310a5e5a4';

function applicableRuns(file) {
	if (file.includes('/src/')) return ['build', 'typecheck', 'actor-remote-integration'];
	if (file.includes('/test/integration/')) return ['actor-remote-integration'];
	if (file.endsWith('/test/helpers/local-actor.ts')) return ['units', 'actor-remote-integration'];
	return ['units'];
}

export function validateLocalActorFieldsEvidence(value, readFile = read, optional = optionalRead) {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'local-actor-fields-finite-identity-renewal');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false, 'posting remains partial');
	assert.equal(value.upstreamFullServerMeasured, false, 'source is not full server');
	assert.deepEqual(Object.keys(value.files).sort(), [...renewedFiles].sort(), 'fields renewal subset');
	assert.deepEqual(Object.keys(value.frozenInputSha256).sort(), measuredFiles, 'fields frozen subset');
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
		assert.equal(sha(readFile(path)), digest, 'fields current input drift');
	}
	for (const binding of [value.predecessor, value.webfingerEvidence]) {
		assert.equal(sha(readFile(binding.path)), binding.sha256, 'fields predecessor drift');
	}
	const predecessor = JSON.parse(readFile(value.predecessor.path));
	for (const [file, binding] of Object.entries(value.files)) {
		assert.equal(binding.previousSha256, predecessor.files[file]?.sha256, 'fields predecessor identity');
		assert.notEqual(binding.previousSha256, binding.sha256, 'fields changed identity');
		assert.equal(binding.sha256, value.frozenInputSha256[file], 'fields frozen identity');
		assert.deepEqual(binding.validatedBy, applicableRuns(file), 'fields applicable runs');
	}
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS', 'fields successful receipt');
	assert.equal(receipt.frozenInputs, 877, 'fields frozen count');
	assert.equal(value.request.frozenInputs, 877, 'fields frozen count');
	assert.equal(value.request.status, 'FROZEN_READY', 'fields frozen request');
	assert.equal(receipt.requestPath, value.request.path, 'fields request binding');
	assert.equal(receipt.requestSha256, value.request.sha256, 'fields request binding');
	assert.equal(receipt.base, value.baseCommit, 'fields request binding');
	assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt), 'fields measurement window');
	assert.deepEqual(receipt.commands.map(c => c.id), requiredRuns, 'fields required runs');
	for (const run of receipt.commands) {
		assert(run.exitCode === 0 && run.command && run.log, 'fields successful run');
		assert.match(run.logSha256, /^[a-f0-9]{64}$/);
		if (['units', 'actor-remote-integration'].includes(run.id)) {
			const count = run.id === 'units' ? 283 : 177;
			assert.deepEqual(run.tests, { numTotalTests: count, numPassedTests: count, numFailedTests: 0, numPendingTests: 0, success: true }, 'fields successful tests');
			assert(run.artifact, 'fields test artifact');
			assert.match(run.artifactSha256, /^[a-f0-9]{64}$/, 'fields test artifact');
		}
	}
	const observations = JSON.parse(readFile(directory + 'local-actor-fields-observations.json'));
	const source = value.sourceOracle;
	assert.equal(observations.upstreamCommit, value.upstreamCommit, 'fields source binding');
	assert.deepEqual(source, {
		...Object.fromEntries(['upstreamCommit', 'manifest', 'corpusSha256', 'bounds', 'doubles', 'projection'].map(key => [key, observations[key]])),
		caseCount: observations.cases.length,
		successCases: observations.cases.filter(c => 'json' in c.expected).length,
		rejectionCases: observations.cases.filter(c => !('json' in c.expected)).length,
	}, 'fields source binding');
	assert.equal(source.caseCount, 21, 'fields source binding');
	assert.equal(source.successCases, 16, 'fields source binding');
	assert.equal(source.rejectionCases, 5, 'fields source binding');
	assert.equal(sha(readFile(directory + 'local-actor-fields-corpus.json')), source.corpusSha256, 'fields source corpus drift');
	for (const key of ['request', 'receipt']) {
		const binding = value[key];
		const bytes = optional(binding.path);
		if (bytes === null) continue;
		assert.equal(sha(bytes), binding.sha256, `fields actual ${key} bytes`);
		const actual = JSON.parse(bytes);
		if (key === 'receipt') {
			assert.deepEqual(actual, receipt, 'fields actual receipt data');
		} else {
			assert.equal(actual.status, value.request.status);
			assert.equal(actual.base, value.baseCommit);
			assert.equal(Object.keys(actual.sha256).length, 877, 'fields actual frozen count');
			assert.equal(sha(canonicalMap(actual.sha256)), value.request.frozenInputMapSha256, 'fields actual frozen map');
			for (const [path, digest] of Object.entries(value.frozenInputSha256)) {
				assert.equal(actual.sha256[path], digest, 'fields actual frozen identity');
			}
			assert.deepEqual(actual.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]), receipt.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]), 'fields actual commands');
		}
	}
	for (const run of receipt.commands) {
		for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
			if (!path) continue;
			const bytes = optional(path);
			if (bytes === null) continue;
			assert.equal(sha(bytes), digest, 'fields actual run bytes');
			if (path === run.artifact) {
				const actual = JSON.parse(bytes);
				assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'fields actual test results');
			}
		}
	}
	assert.equal(sha(JSON.stringify(value)), canonicalRecordSha256, 'fields canonical record');
}

// This leaf deliberately imports no earlier evidence helper. Historical callers
// keep their projections; current-byte callers append this finite hop explicitly.
export function localActorFieldsDigest(file, previousDigest, readFile = read, optional = optionalRead) {
	if (!renewedFiles.includes(file)) return previousDigest;
	const value = JSON.parse(readFile(evidencePath));
	const binding = value.files[file];
	assert(previousDigest === binding.previousSha256 || previousDigest === binding.sha256, 'fields previous identity');
	validateLocalActorFieldsEvidence(value, readFile, optional);
	return binding.sha256;
}
