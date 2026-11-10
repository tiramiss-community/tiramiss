/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { metadataDigest } from './instance-metadata-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/instance-metadata/';
const read = file => readFileSync(new URL(file, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');

function validate(value) {
	assert.equal(value.status, 'VALIDATED');
	assert.equal(value.postingComplete, false);
	assert.equal(value.notesCreateStatus, 'partial');
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	assert.equal(value.scope, 'current-public-actor-and-delivery-callers');
	for (const [file, digest] of Object.entries(value.historicalSha256)) {
		assert.equal(sha(read(file)), digest, 'historical evidence preserved');
	}
	assert.equal(sha(read(directory + 'observations.json')), value.observationsSha256);
	assert.equal(sha(read(directory + 'source-probe.mjs')), value.probeSha256);
	for (const id of ['integration', 'process', 'full-unit']) {
		const measurement = value.measurements[id];
		assert.equal(measurement.outcome, 'PASS');
		assert.equal(measurement.failed, 0);
		assert.equal(measurement.skipped, 0);
		assert(measurement.passed > 0);
		assert.match(measurement.artifactSha256, /^[a-f0-9]{64}$/);
		assert(measurement.command && measurement.startedAt && measurement.finishedAt, 'actual run provenance');
		for (const [file, digest] of Object.entries(measurement.sourceSha256)) {
			assert.equal(sha(read(file)), digest, 'current measured input');
		}
	}
	for (const [file, renewal] of Object.entries(value.renewals)) {
		assert(renewal.previousSha256.length > 0);
		assert.equal(value.measurements[renewal.measurement].sourceSha256[file], renewal.sourceSha256);
		assert.equal(sha(read(file)), renewal.sourceSha256);
	}
}

test('pinned metadata observations include independent failures, boundaries and scheduled live delivery gate', () => {
	const source = JSON.parse(read(directory + 'observations.json'));
	assert.equal(source.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.cases.length, 27);
	const cases = new Map(source.cases.map(c => [c.id, c.expected]));
	assert.equal(cases.get('all-sources').patch.name, 'Node');
	assert.equal(cases.get('manifest-fallback').patch.description, 'Manifest');
	assert.equal(cases.get('invalid-color-no-fallback').patch.themeColor, undefined);
	assert.equal(cases.get('fresh-minus-one').patch, null);
	assert(cases.get('exact-24h').patch.infoUpdatedAt);
	assert.equal(cases.get('locked-contender').events.some(e => e[0] === 'del' && e[1].includes(':v2:')), false);
	assert.equal(cases.get('lock-error').rejection, 'lock');
	assert.equal(cases.get('unlock-error').rejection, 'unlock');
	assert.equal(source.callerCases.length, 5);
	for (const fixture of source.callerCases) {
		assert.equal(fixture.expected.events.includes('metadata.start'), fixture.input.instance && fixture.input.finalStats);
		assert(fixture.expected.events.indexOf('result.returned') < fixture.expected.events.indexOf('metadata.start') || !fixture.expected.events.includes('metadata.start'));
	}
});

test('metadata renewals bind actual successful frozen runs without rewriting historical evidence', () => validate(JSON.parse(read(directory + 'runtime-evidence.json'))));
for (const [name, mutate] of [
	['completion claim', v => {
		v.postingComplete = true;
	}],
	['failed run', v => {
		v.measurements.process.outcome = 'FAIL';
	}],
	['unmeasured input', v => {
		v.measurements.integration.sourceSha256['packages/backend-next/test/integration/instance-metadata.test.ts'] = '0'.repeat(64);
	}],
	['invented current identity', v => {
		Object.values(v.renewals)[0].sourceSha256 = '0'.repeat(64);
	}],
]) {
	test(`metadata evidence rejects ${name}`, () => {
		const value = JSON.parse(read(directory + 'runtime-evidence.json'));
		mutate(value); assert.throws(() => validate(value));
	});
}
test('current-byte projection rejects an unmeasured historical identity', () => {
	assert.throws(() => metadataDigest('packages/backend-next/src/platform/connect-resources.ts', '0'.repeat(64)));
});
