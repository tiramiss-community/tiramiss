/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { actorInstanceDigest } from './actor-instance-registration-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const read = path => readFileSync(new URL(path, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
function validateSource(value) {
	assert.equal(value.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(value.upstreamHttpMeasured, false);
	assert.equal(value.cases.length, 13);
	assert.equal(new Set(value.cases.map(c => c.id)).size, 13);
	for (const binding of ['ApRendererService.renderPerson', 'MfmService.toHtml', 'escapeHtml', 'concat', 'intersperse']) {
		assert(value.bindings.includes(binding), 'real helper binding');
		assert.match(value.methods[binding].sha256, /^[a-f0-9]{64}$/);
	}
	assert.equal(Object.keys(value.doubles).length, 5);
	const byId = id => value.cases.find(c => c.id === id);
	assert.deepEqual(byId('description-0').expected.raw.attachment, { $undefined: true });
	assert(!Object.hasOwn(byId('description-0').expected.json, 'attachment'));
	assert.equal(byId('description-0').expected.json._misskey_summary, null);
	assert.equal(byId('description-1').expected.json._misskey_summary, '');
	assert.equal(byId('description-7').expected.error.name, 'TypeError');
	assert.equal(byId('missing-profile').expected.error.message, 'profile missing');
	assert.equal(byId('database-error').expected.error.message, 'database unavailable');
}
function validateEvidence(value) {
	assert.equal(value.postingComplete, false);
	assert.equal(value.notesCreateStatus, 'partial');
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	for (const [file, digest] of Object.entries(value.historicalSha256)) assert.equal(sha(read(file)), digest, 'historical corpus/receipt preserved');
	assert.equal(sha(read(directory + 'local-actor-profile-observations.json')), value.observationsSha256);
	assert.equal(sha(read(directory + 'local-actor-profile-source-probe.mjs')), value.probeSha256);
	for (const id of ['units', 'integration', 'process']) {
		const measured = value.measurements[id];
		assert.equal(measured.outcome, 'PASS', 'successful actual measurement');
		assert(measured.passed > 0);
		assert.equal(measured.failed, 0);
		assert.equal(measured.skipped, 0);
		assert.match(measured.artifactSha256, /^[a-f0-9]{64}$/);
		for (const [file, digest] of Object.entries(measured.sourceSha256)) assert.equal(sha(read(file)), actorInstanceDigest(file, digest), 'measured current file');
	}
	for (const [file, renewal] of Object.entries(value.renewals)) {
		assert.match(renewal.historicalSha256, /^[a-f0-9]{64}$/);
		assert.equal(value.measurements[renewal.measurement].sourceSha256[file], renewal.sourceSha256, 'renewal measured');
		assert.equal(sha(read(file)), actorInstanceDigest(file, renewal.sourceSha256), 'renewal current');
	}
}
test('independent profile source preserves raw omission and failure outcomes', () => validateSource(JSON.parse(read(directory + 'local-actor-profile-observations.json'))));
test('profile evidence contains only measured renewals and preserves five gaps', () => validateEvidence(JSON.parse(read(directory + 'local-actor-profile-runtime-evidence.json'))));
for (const [name, mutate] of [
	['premature completion', v => { v.postingComplete = true; }],
	['missing runtime run', v => { delete v.measurements.process; }],
	['unmeasured renewal', v => { Object.values(v.renewals)[0].sourceSha256 = '0'.repeat(64); }],
	['closed rich actor gap', v => { v.remainingGapIds.pop(); }],
]) test(`profile evidence rejects ${name}`, () => {
	const value = JSON.parse(read(directory + 'local-actor-profile-runtime-evidence.json'));
	mutate(value);
	assert.throws(() => validateEvidence(value));
});
