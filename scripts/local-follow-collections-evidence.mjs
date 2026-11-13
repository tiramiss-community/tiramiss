/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-follow-collections-current-evidence.json';
const predecessorPath = directory + 'local-featured-current-evidence.json';
const predecessorSha256 = '18e684d5c1ec212f6e3dff481764ab74385a3df7cf423f85108c99112c6a791f';
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
	'src/composition/http-app.ts', 'src/modules/federation/public.ts', 'test/unit/composition/http-app.test.ts',
].map(path => 'packages/backend-next/' + path);
const measuredFiles = [
	"docs/superpowers/compatibility/remote-user/local-featured-corpus.json",
	"docs/superpowers/compatibility/remote-user/local-featured-observations.json",
	"docs/superpowers/compatibility/remote-user/local-featured-source-probe.mjs",
	"docs/superpowers/compatibility/remote-user/local-follow-collections-corpus.json",
	"docs/superpowers/compatibility/remote-user/local-follow-collections-observations.json",
	"docs/superpowers/compatibility/remote-user/local-follow-collections-source-probe.mjs",
	"packages/backend-next/src/composition/featured-http.ts",
	"packages/backend-next/src/composition/follow-collections-http.ts",
	"packages/backend-next/src/composition/http-app.ts",
	"packages/backend-next/src/composition/published-note.ts",
	"packages/backend-next/src/composition/webfinger-http.ts",
	"packages/backend-next/src/http/activitypub-actor-api.ts",
	"packages/backend-next/src/http/activitypub-follow-collections-api.ts",
	"packages/backend-next/src/http/activitypub-notes-api.ts",
	"packages/backend-next/src/http/webfinger-api.ts",
	"packages/backend-next/src/modules/federation/local-actor.ts",
	"packages/backend-next/src/modules/federation/local-featured.ts",
	"packages/backend-next/src/modules/federation/local-follow-collections.ts",
	"packages/backend-next/src/modules/federation/local-webfinger.ts",
	"packages/backend-next/src/modules/federation/note-activity.ts",
	"packages/backend-next/src/modules/federation/public.ts",
	"packages/backend-next/src/platform/database/local-actors.ts",
	"packages/backend-next/src/platform/database/local-featured.ts",
	"packages/backend-next/src/platform/database/local-follow-collections.ts",
	"packages/backend-next/src/platform/database/note-activity.ts",
	"packages/backend-next/test/helpers/local-actor-fields.ts",
	"packages/backend-next/test/helpers/local-actor.ts",
	"packages/backend-next/test/helpers/local-featured.ts",
	"packages/backend-next/test/helpers/local-follow-collections.ts",
	"packages/backend-next/test/helpers/webfinger-source.ts",
	"packages/backend-next/test/integration/activitypub-actor.test.ts",
	"packages/backend-next/test/integration/http-app.test.ts",
	"packages/backend-next/test/integration/local-featured-http.test.ts",
	"packages/backend-next/test/integration/local-follow-collections-http.test.ts",
	"packages/backend-next/test/integration/migrations.test.ts",
	"packages/backend-next/test/integration/note-activity.test.ts",
	"packages/backend-next/test/integration/remote-user.test.ts",
	"packages/backend-next/test/integration/webfinger.test.ts",
	"packages/backend-next/test/unit/composition/http-app.test.ts",
	"packages/backend-next/test/unit/federation/actor-api.test.ts",
	"packages/backend-next/test/unit/federation/local-actor-fields.test.ts",
	"packages/backend-next/test/unit/federation/local-actor-images.test.ts",
	"packages/backend-next/test/unit/federation/local-actor-profile.test.ts",
	"packages/backend-next/test/unit/federation/local-actor-tags.test.ts",
	"packages/backend-next/test/unit/federation/local-actor.test.ts",
	"packages/backend-next/test/unit/federation/local-featured-red.test.ts",
	"packages/backend-next/test/unit/federation/local-featured.test.ts",
	"packages/backend-next/test/unit/federation/local-follow-collections.test.ts",
	"packages/backend-next/test/unit/federation/note-activity.test.ts",
	"packages/backend-next/test/unit/federation/note-delivery.test.ts",
	"packages/backend-next/test/unit/federation/webfinger-api.test.ts",
	"packages/backend-upstream/.managed-files.json",
	"packages/backend-upstream/exports/entities.ts",
	"packages/backend-upstream/src/models/UserNotePining.ts",
	"packages/backend-upstream/upstream-sync.json"
];
const requiredRuns = ['sync-check', 'upstream-tests', 'build', 'typecheck', 'units', 'db-http', 'acceptance', 'source-probe', 'shipping'];
const testCounts = { units: 3543, 'db-http': 1139, acceptance: 65 };
// Exact parent R2 request/receipt, finite current subset and all 987 input identities
// are sealed together. Temporary host artifacts are optional only when absent.
const canonicalRecordSha256 = '5e988b100594c786564fc78780796c88daf2aa70d9edde8ecef271d1dda73c99';
const recordBytesSha256 = 'c3559a2cdbf0c695c091750182136abb18802069702c05939022b6a1d9afcede';

export function validateLocalFollowCollectionsEvidence(value, readFile = read, optional = optionalRead, driftLabel = 'follow collections current input drift') {
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.scope, 'local-follow-collections-finite-identity-hop');
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false, 'posting remains partial');
	assert.equal(value.upstreamFullServerMeasured, false, 'source is not full server');
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	assert.deepEqual(value.validationContext, { project: 'backend-next-s1-r13', ports: { postgres: 55516, redis: 56416, meilisearch: 57816 }, ciMeasured: false }, 'follow collections validation context');
	assert.deepEqual(Object.keys(value.files).sort(), [...renewedFiles].sort(), 'follow collections renewal subset');
	assert.deepEqual(Object.keys(value.frozenInputSha256).sort(), measuredFiles, 'follow collections frozen subset');
	for (const [path, digest] of Object.entries(value.frozenInputSha256)) assert.equal(sha(readFile(path)), digest, driftLabel);
	for (const [file, binding] of Object.entries(value.files)) {
		assert.deepEqual(binding.predecessor, { path: predecessorPath, sha256: predecessorSha256, pointer: ['files', file, 'sha256'] }, 'follow collections predecessor binding');
		const bytes = readFile(predecessorPath);
		assert.equal(sha(bytes), predecessorSha256, 'follow collections predecessor drift');
		const previous = JSON.parse(bytes).files[file]?.sha256;
		assert.match(previous ?? '', /^[a-f0-9]{64}$/, 'follow collections predecessor identity');
		assert.equal(binding.previousSha256, previous, 'follow collections predecessor identity');
		assert.notEqual(binding.sha256, previous, 'follow collections changed identity');
		assert.equal(binding.sha256, value.frozenInputSha256[file], 'follow collections frozen identity');
		assert.deepEqual(binding.validatedBy, file.includes('/test/') ? ['units'] : ['build', 'typecheck', 'units', 'db-http'], 'follow collections applicable runs');
	}
	const receipt = value.receipt.record;
	assert.equal(receipt.status, 'PASS', 'follow collections successful receipt');
	assert.equal(receipt.frozenInputs, 987, 'follow collections frozen count');
	assert.equal(value.request.frozenInputs, 987, 'follow collections frozen count');
	assert.equal(value.request.status, 'READY_FOR_HOST_VALIDATION', 'follow collections frozen request');
	assert.equal(receipt.requestPath, value.request.path, 'follow collections request binding');
	assert.equal(receipt.requestSha256, value.request.sha256, 'follow collections request binding');
	assert.equal(receipt.base, value.baseCommit, 'follow collections request binding');
	assert.equal(receipt.inputsSha256, value.request.frozenInputMapSha256, 'follow collections full map binding');
	assert.equal(receipt.runtime, 'v26.4.0', 'follow collections runtime');
	assert.equal(receipt.pnpm, '12.9.1', 'follow collections runtime');
	const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.completedAt);
	assert(Number.isFinite(start) && end >= start, 'follow collections measurement window');
	assert.deepEqual(receipt.runs.map(c => c.id), requiredRuns, 'follow collections required runs');
	assert.deepEqual(value.request.commands.map(c => [c.id, c.command, c.log]), receipt.runs.map(c => [c.id, c.command, c.log]), 'follow collections commands binding');
	for (const run of receipt.runs) {
		assert(run.exitCode === 0 && Array.isArray(run.command) && run.command.length > 0 && run.log, 'follow collections successful run');
		assert.equal(run.frozenInputsUnchanged, true, 'follow collections zero input drift');
		assert(start <= Date.parse(run.startedAt) && Date.parse(run.startedAt) <= Date.parse(run.completedAt) && Date.parse(run.completedAt) <= end, 'follow collections run window');
		assert.match(run.logSha256 ?? '', /^[a-f0-9]{64}$/, 'follow collections log hash');
		if (run.id in testCounts) {
			const count = testCounts[run.id];
			assert.deepEqual(run.tests, { numTotalTests: count, numPassedTests: count, numFailedTests: 0, numPendingTests: 0, success: true }, 'follow collections successful tests');
			assert(run.artifact && /^[a-f0-9]{64}$/.test(run.artifactSha256), 'follow collections test artifact');
		}
	}
	assert.deepEqual(value.logMeasurements, { 'upstream-tests': { passed: 5, failed: 0, skipped: 0 }, 'source-probe': { passed: 138, injections: 138, failed: 0, skipped: 0 } }, 'follow collections log measurements');
	const observations = JSON.parse(readFile(value.sourceOracle.path));
	assert.equal(observations.upstreamCommit, value.upstreamCommit, 'follow collections source provenance');
	assert.equal(observations.cases.length, 138, 'follow collections source count');
	assert.equal(value.sourceOracle.caseCount, 138, 'follow collections source count');
	for (const key of ['runtime', 'queryParser']) assert.deepEqual(value.sourceOracle[key], observations[key], 'follow collections source provenance');
	for (const key of ['manifest', 'doubles']) assert.equal(value.sourceOracle[key + 'Sha256'], sha(JSON.stringify(observations[key])), 'follow collections source provenance');
	assert.equal(value.sourceOracle.corpusSha256, observations.corpusSha256, 'follow collections source provenance');
	assert.equal(sha(readFile(directory + 'local-follow-collections-corpus.json')), observations.corpusSha256, 'follow collections corpus drift');
	const tests = measuredFiles.filter(p => p.includes('/test/') && p.endsWith('.test.ts'));
	assert.deepEqual(Object.keys(value.testFileMeasurements).sort(), tests, 'follow collections measured test subset');
	for (const [file, measurement] of Object.entries(value.testFileMeasurements)) {
		assert.equal(measurement.run, file.includes('/test/unit/') ? 'units' : 'db-http', 'follow collections measured test run');
		assert(measurement.passed > 0 && measurement.failed === 0 && measurement.skipped === 0, 'follow collections measured test success');
	}
	assert.equal(value.testFileMeasurements['packages/backend-next/test/integration/local-follow-collections-http.test.ts'].passed, 144, 'follow collections PG HTTP count');
	// This pins exact commands, hashes, timestamps and counts even in CI without /tmp.
	assert.equal(sha(JSON.stringify(value)), canonicalRecordSha256, 'follow collections canonical record');
	for (const key of ['request', 'receipt']) {
		const binding = value[key], bytes = optional(binding.path);
		if (bytes === null) continue;
		assert.equal(sha(bytes), binding.sha256, `follow collections actual ${key} bytes`);
		const actual = JSON.parse(bytes);
		if (key === 'receipt') assert.deepEqual(actual, receipt, 'follow collections actual receipt data');
		else {
			assert.equal(actual.status, value.request.status, 'follow collections actual request status');
			assert.equal(actual.base, value.baseCommit, 'follow collections actual request base');
			assert.equal(actual.frozenInputs, 987, 'follow collections actual frozen count');
			assert.equal(Object.keys(actual.sha256).length, 987, 'follow collections actual frozen count');
			assert.equal(sha(canonicalMap(actual.sha256)), value.request.frozenInputMapSha256, 'follow collections actual frozen map');
			for (const [path, digest] of Object.entries(value.frozenInputSha256)) assert.equal(actual.sha256[path], digest, 'follow collections actual frozen identity');
			assert.deepEqual(actual.commands, value.request.commands, 'follow collections actual commands');
		}
	}
	for (const run of receipt.runs) {
		for (const [path, digest] of [[run.log, run.logSha256], [run.artifact, run.artifactSha256]]) {
			if (!path) continue;
			const bytes = optional(path);
			if (bytes === null) continue;
			assert.equal(sha(bytes), digest, 'follow collections actual run bytes');
			if (path === run.artifact) {
				const actual = JSON.parse(bytes);
				assert.deepEqual(Object.fromEntries(Object.keys(run.tests).map(key => [key, actual[key]])), run.tests, 'follow collections actual test results');
				for (const [file, measurement] of Object.entries(value.testFileMeasurements).filter(([, m]) => m.run === run.id)) {
					const matches = actual.testResults.filter(t => t.name.endsWith('/' + file));
					assert.equal(matches.length, 1, 'follow collections actual test file');
					assert.equal(matches[0].status, 'passed');
					assert.equal(matches[0].assertionResults.length, measurement.passed);
					assert(matches[0].assertionResults.every(t => t.status === 'passed'), 'follow collections actual test file success');
				}
			} else if (run.id === 'upstream-tests') {
				for (const [name, count] of Object.entries({ tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) assert.match(bytes.toString(), new RegExp(`ℹ ${name} ${count}\\n`), 'follow collections actual upstream counts');
			} else if (run.id === 'source-probe') assert.equal(bytes.toString(), 'local follow source: 138 cases --check\n', 'follow collections actual source count');
		}
	}
}

// A leaf with no ancestor imports/calls. New inputs have no invented predecessor.
export function localFollowCollectionsDigest(file, previousDigest, readFile = read, optional = optionalRead, driftLabel) {
	if (!renewedFiles.includes(file)) return previousDigest;
	const bytes = readFile(evidencePath), value = JSON.parse(bytes), binding = value.files[file];
	assert(binding && (previousDigest === binding.previousSha256 || previousDigest === binding.sha256), 'follow collections previous identity');
	validateLocalFollowCollectionsEvidence(value, readFile, optional, driftLabel);
	assert.equal(sha(bytes), recordBytesSha256, 'follow collections record bytes');
	return binding.sha256;
}
