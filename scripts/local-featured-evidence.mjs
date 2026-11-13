/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { localFollowCollectionsDigest } from './local-follow-collections-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-featured-current-evidence.json';
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
	'src/composition/http-app.ts', 'src/modules/federation/note-activity.ts', 'src/platform/database/note-activity.ts',
	'src/modules/federation/public.ts', 'test/unit/composition/http-app.test.ts',
].map(path => 'packages/backend-next/' + path);
const measuredFiles = [
	...['corpus.json', 'observations.json', 'source-probe.mjs'].map(name => directory + 'local-featured-' + name),
	...[
		'src/composition/featured-http.ts', 'src/composition/http-app.ts', 'src/composition/published-note.ts',
		'src/http/activitypub-notes-api.ts', 'src/modules/federation/local-featured.ts',
		'src/modules/federation/note-activity.ts', 'src/modules/federation/public.ts',
		'src/platform/database/local-featured.ts', 'src/platform/database/note-activity.ts',
		'test/helpers/local-featured.ts', 'test/integration/local-featured-http.test.ts',
		'test/unit/composition/http-app.test.ts', 'test/unit/federation/local-featured-red.test.ts',
		'test/unit/federation/local-featured.test.ts', 'test/unit/federation/note-activity.test.ts',
		'test/unit/federation/note-delivery.test.ts', 'test/unit/federation/actor-api.test.ts',
		'test/integration/note-activity.test.ts', 'test/integration/activitypub-actor.test.ts',
		'test/integration/migrations.test.ts',
	].map(path => 'packages/backend-next/' + path),
	...['.managed-files.json', 'exports/entities.ts', 'src/models/UserNotePining.ts', 'upstream-sync.json'].map(path => 'packages/backend-upstream/' + path),
].sort();
const requiredRuns = ['sync-check', 'upstream-tests', 'build', 'typecheck', 'units', 'db-http', 'schema-migrations', 'source-probe', 'shipping', 'composition'];
const testCounts = { units: 257, 'db-http': 203, 'schema-migrations': 6, composition: 6 };
// Seals the actual receipt and finite subset, not an enlarged ancestor proof graph.
const canonicalRecordSha256 = 'f6f6ec9a456cf358bd78f3a725f32ccc54df1ded53784d976324ad5430556955';
const recordBytesSha256 = '18e684d5c1ec212f6e3dff481764ab74385a3df7cf423f85108c99112c6a791f';

export function validateLocalFeaturedEvidence(value, readFile = read, optional = optionalRead, driftLabel = 'featured current input drift') {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'local-featured-finite-identity-hop');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false, 'posting remains partial');
	assert.equal(value.upstreamFullServerMeasured, false, 'source is not full server');
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	assert.deepEqual(Object.keys(value.files).sort(), [...renewedFiles].sort(), 'featured renewal subset');
	assert.deepEqual(Object.keys(value.frozenInputSha256).sort(), measuredFiles, 'featured frozen subset');
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) assert.equal(sha(readFile(path)), localFollowCollectionsDigest(path, digest, readFile, optional, driftLabel), driftLabel);
	for (const [file, binding] of Object.entries(value.files)) {
		const predecessor = binding.predecessor;
		const bytes = readFile(predecessor.path);
		assert.equal(sha(bytes), predecessor.sha256, 'featured predecessor drift');
		const previous = predecessor.pointer.reduce((v, key) => v?.[key], JSON.parse(bytes));
		assert.match(previous, /^[a-f0-9]{64}$/, 'featured predecessor identity');
		assert.equal(binding.previousSha256, previous, 'featured predecessor identity');
		assert.notEqual(binding.sha256, previous, 'featured changed identity');
		assert.equal(binding.sha256, value.frozenInputSha256[file], 'featured frozen identity');
		assert.deepEqual(binding.validatedBy, file.endsWith('http-app.test.ts') ? ['composition'] : file.endsWith('/composition/http-app.ts') ? ['build', 'typecheck', 'db-http', 'composition'] : ['build', 'typecheck', 'units', 'db-http'], 'featured applicable runs');
	}
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS', 'featured successful receipt');
	assert.equal(receipt.frozenInputs, 1084, 'featured frozen count');
	assert.equal(value.request.frozenInputs, 1084, 'featured frozen count');
	assert.equal(value.request.status, 'READY_FOR_HOST_VALIDATION', 'featured frozen request');
	assert.equal(receipt.requestPath, value.request.path, 'featured request binding');
	assert.equal(receipt.requestSha256, value.request.sha256, 'featured request binding');
	assert.equal(receipt.base, value.baseCommit, 'featured request binding');
	assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt), 'featured measurement window');
	assert.deepEqual(receipt.commands.map(c => c.id), requiredRuns, 'featured required runs');
	for (const run of receipt.commands) {
		assert(run.exitCode === 0 && run.command && run.log, 'featured successful run');
		assert.match(run.logSha256 ?? '', /^[a-f0-9]{64}$/, 'featured log hash');
		if (run.id in testCounts) {
			const count = testCounts[run.id];
			assert.deepEqual(run.tests, { numTotalTests: count, numPassedTests: count, numFailedTests: 0, numPendingTests: 0, success: true }, 'featured successful tests');
			assert(run.artifact && /^[a-f0-9]{64}$/.test(run.artifactSha256), 'featured test artifact');
		}
	}
	assert.deepEqual(value.logMeasurements, { 'upstream-tests': { passed: 5, failed: 0, skipped: 0 }, 'source-probe': { passed: 100, failed: 0, skipped: 0 } }, 'featured log measurements');
	const observations = JSON.parse(readFile(value.sourceOracle.path));
	assert.equal(observations.upstreamCommit, value.upstreamCommit, 'featured source provenance');
	assert.equal(observations.cases.length, 100, 'featured source count');
	assert.equal(value.sourceOracle.caseCount, 100, 'featured source count');
	assert.equal(sha(JSON.stringify(observations.manifest)), value.sourceOracle.manifestSha256, 'featured source provenance');
	assert.equal(sha(JSON.stringify(observations.doubles)), value.sourceOracle.doublesSha256, 'featured source provenance');
	assert.equal(observations.corpusSha256, value.sourceOracle.corpusSha256, 'featured source provenance');
	assert.equal(sha(readFile(directory + 'local-featured-corpus.json')), observations.corpusSha256, 'featured corpus drift');
	// Fail on semantic/provenance edits even when the ephemeral host files are absent.
	assert.equal(sha(JSON.stringify(value)), canonicalRecordSha256, 'featured canonical record');
	for (const key of ['request', 'receipt']) {
		const binding = value[key];
		const bytes = optional(binding.path);
		if (bytes === null) continue;
		assert.equal(sha(bytes), binding.sha256, `featured actual ${key} bytes`);
		const actual = JSON.parse(bytes);
		if (key === 'receipt') assert.deepEqual(actual, receipt, 'featured actual receipt data');
		else {
			assert.equal(actual.status, value.request.status);
			assert.equal(actual.base, value.baseCommit);
			assert.equal(Object.keys(actual.sha256).length, 1084, 'featured actual frozen count');
			assert.equal(sha(canonicalMap(actual.sha256)), value.request.frozenInputMapSha256, 'featured actual frozen map');
			for (const [path, digest] of Object.entries(value.frozenInputSha256)) assert.equal(actual.sha256[path], digest, 'featured actual frozen identity');
			assert.deepEqual(actual.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]), receipt.commands.map(c => [c.id, c.command, c.log, c.artifact ?? null]), 'featured actual commands');
		}
	}
	for (const run of receipt.commands) {
		for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
			if (!path) continue;
			const bytes = optional(path);
			if (bytes === null) continue;
			assert.equal(sha(bytes), digest, 'featured actual run bytes');
			if (path === run.artifact) {
				const actual = JSON.parse(bytes);
				assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'featured actual test results');
			} else if (run.id === 'upstream-tests') {
				for (const [name, count] of Object.entries({ tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) assert.match(bytes.toString(), new RegExp(`ℹ ${name} ${count}\\n`), 'featured actual upstream counts');
			} else if (run.id === 'source-probe') assert.equal(bytes.toString(), 'local-featured source: 100 cases --check\n', 'featured actual source count');
		}
	}
}

// Only the explicit successor leaf is imported; no ancestor recursion or global traversal. New files have no invented predecessor.
export function localFeaturedDigest(file, previousDigest, readFile = read, optional = optionalRead, driftLabel) {
	if (!renewedFiles.includes(file)) return previousDigest;
	const bytes = readFile(evidencePath);
	const value = JSON.parse(bytes);
	const binding = value.files[file];
	assert(binding && (previousDigest === binding.previousSha256 || previousDigest === binding.sha256), 'featured previous identity');
	assert.equal(sha(JSON.stringify(value)), canonicalRecordSha256, 'featured canonical record');
	assert.equal(sha(bytes), recordBytesSha256, 'featured record bytes');
	validateLocalFeaturedEvidence(value, readFile, optional, driftLabel);
	return binding.sha256;
}
