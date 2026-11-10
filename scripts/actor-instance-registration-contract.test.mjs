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

test('new source observation gates prove normal/duplicate stats, origin authority and separate nonwaiting boundaries', () => {
	const source = JSON.parse(read(directory + 'actor-instance-registration-observations.json'));
	assert.equal(source.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.upstreamHttpMeasured, false);
	assert.equal(source.methods['ApPersonService.createPerson'].sha256, 'c2e3b8e9efd102fefcae50e7c51a17ba67741f1c9410148ee33a87b33838e7af');
	assert.equal(source.fullFileSha256['core/activitypub/models/ApPersonService.ts'], '471168b426b6ec19294b345bd0f66ac1c46fd554475c7c396bdbd9d859624921');
	assert.equal(source.cases.length, 11);
	for (const duplicate of [true, false]) {
		for (const stats of [true, false]) {
			const row = source.cases.find(c => c.input.duplicate === duplicate && c.input.stats === stats && !c.input.origin);
			assert(row);
			assert.equal(row.expected.events.some(e => e.op === 'register.start'), stats);
		}
	}
	for (const gate of ['register', 'increment']) {
		const row = source.cases.find(c => c.input.gate === gate);
		assert.equal(row.expected.events.find(e => e.op === 'actor.settled').args[gate + 'Pending'], true);
	}
	assert.equal(source.cases.find(c => c.input.origin).expected.events.find(e => e.op === 'register.start').args.host, 'origin.test');
});

function validate(value) {
	assert.equal(value.notesCreateStatus, 'partial');
	assert.equal(value.postingComplete, false);
	assert.deepEqual(value.remainingGapIds, ['media-emoji', 'instance-metadata', 'charts', 'rich-actor', 'remote-cache']);
	for (const [file, digest] of Object.entries(value.historicalSha256)) {
		assert.equal(sha(read(file)), digest);
	}
	for (const id of ['integration', 'process', 'full-unit']) {
		const measured = value.measurements[id];
		assert.equal(measured.outcome, 'PASS'); assert.equal(measured.failed, 0); assert.equal(measured.skipped, 0); assert(measured.passed > 0);
		assert.match(measured.artifactSha256, /^[a-f0-9]{64}$/);
		for (const [file, digest] of Object.entries(measured.sourceSha256)) {
			assert.equal(sha(read(file)), digest);
		}
	}
	for (const [file, renewal] of Object.entries(value.renewals)) {
		assert.equal(value.measurements[renewal.measurement].sourceSha256[file], renewal.sourceSha256);
		assert.equal(sha(read(file)), actorInstanceDigest(file, renewal.previousSha256[0]));
	}
}

test('current instance evidence keeps historic receipts intact and renews only actually tested frozen bytes', () => validate(JSON.parse(read(directory + 'actor-instance-registration-runtime-evidence.json'))));
for (const [name, mutate] of [
	['completion', value => {
		value.postingComplete = true;
	}],
	['unmeasured run', value => {
		value.measurements.process.outcome = 'FAIL';
	}],
	['untested byte', value => {
		Object.values(value.renewals)[0].sourceSha256 = '0'.repeat(64);
	}],
]) {
	test(`current instance evidence rejects ${name}`, () => {
		const value = JSON.parse(read(directory + 'actor-instance-registration-runtime-evidence.json')); mutate(value); assert.throws(() => validate(value));
	});
}
