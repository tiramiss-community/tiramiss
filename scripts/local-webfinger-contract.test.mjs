/*
	* SPDX-FileCopyrightText: syuilo and misskey-project
	* SPDX-License-Identifier: AGPL-3.0-only
	*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { localWebfingerDigest, validateLocalWebfingerEvidence } from './local-webfinger-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const record = () => JSON.parse(read('docs/superpowers/compatibility/remote-user/local-webfinger-current-evidence.json'));

test('WebFinger single hop validates committed provenance with host artifacts present or absent', () => {
	const v = record();
	validateLocalWebfingerEvidence(v);
	validateLocalWebfingerEvidence(v, read, () => null);
	assert.equal(localWebfingerDigest(v.file, v.previousSha256), v.sha256);
	assert.equal(localWebfingerDigest(v.file, v.sha256), v.sha256);
	assert.equal(localWebfingerDigest('packages/backend-next/src/composition/http-app.ts', 'unrelated'), 'unrelated');
	assert.throws(() => localWebfingerDigest(v.file, '0'.repeat(64)), /WebFinger previous identity/);
});
for (const [name, mutate, error] of [
	['wrong previous', v => { v.previousSha256 = '0'.repeat(64); }, /WebFinger predecessor identity/],
	['unfrozen', v => { delete v.frozenInputSha256[v.file]; }, /WebFinger frozen identity/],
	['unvalidated', v => { v.validatedBy = []; }, /WebFinger applicable runs/],
	['inapplicable', v => { v.validatedBy = ['source-check']; }, /WebFinger applicable runs/],
	['unknown run', v => { v.validatedBy.push('imaginary'); }, /WebFinger applicable runs/],
	['failed run', v => { v.receipt.record.commands[0].exitCode = 1; }, /WebFinger successful run/],
	['failed tests', v => { v.receipt.record.commands[2].tests.numFailedTests = 1; }, /WebFinger successful tests/],
	['skipped tests', v => { v.receipt.record.commands[3].tests.numPendingTests = 1; }, /WebFinger successful tests/],
	['missing run', v => { v.receipt.record.commands.splice(3, 1); }, /WebFinger required runs/],
	['missing artifact', v => { delete v.receipt.record.commands[2].artifact; }, /WebFinger test artifact/],
	['source binding', v => { v.sourceOracle.sourceManifest[0].methods.createServer = '0'.repeat(64); }, /WebFinger source binding/],
	['raw request binding', v => { v.request.sha256 = '0'.repeat(64); }, /WebFinger request binding/],
	['premature completion', v => { v.postingComplete = true; }, /posting remains partial/],
	['full server claim', v => { v.upstreamFullServerMeasured = true; }, /source is not full server/],
]) test(`WebFinger rejects ${name} without optional host files`, () => {
	const v = record(); mutate(v);
	assert.throws(() => validateLocalWebfingerEvidence(v, read, () => null), error);
});
test('WebFinger rejects current source and immutable history tampering', () => {
	const v = record();
	for (const path of [v.file, v.predecessor.path, v.runtimeEvidence.path, v.previousCurrentRecord.path, ...Object.keys(v.frozenInputSha256)]) {
		assert.throws(() => validateLocalWebfingerEvidence(v, p => p === path ? Buffer.from('drift') : read(p), () => null), /WebFinger .* drift/);
	}
});
test('WebFinger checks available raw request receipt logs and result artifacts', () => {
	const v = record();
	for (const path of [v.request.path, v.receipt.path, ...v.receipt.record.commands.flatMap(c => [c.log, c.artifact].filter(Boolean))]) {
		assert.throws(() => validateLocalWebfingerEvidence(v, read, p => p === path ? Buffer.from('{}') : null), /WebFinger actual .* bytes/);
	}
});
test('WebFinger renews only the actually drifted composition unit consumer', () => {
	const v = record();
	assert.equal(localWebfingerDigest(v.consumerRenewal.file, v.consumerRenewal.previousSha256), v.consumerRenewal.sha256);
	assert.equal(localWebfingerDigest(v.consumerRenewal.file, v.consumerRenewal.sha256), v.consumerRenewal.sha256);
	assert.throws(() => localWebfingerDigest(v.consumerRenewal.file, '0'.repeat(64)), /WebFinger previous identity/);
});
for (const [name, mutate, error] of [
	['invented consumer predecessor', v => { v.consumerRenewal.previousSha256 = '0'.repeat(64); }, /WebFinger consumer predecessor identity/],
	['unfrozen consumer', v => { delete v.frozenInputSha256[v.consumerRenewal.file]; }, /WebFinger consumer frozen identity/],
	['consumer attached to HTTP run', v => { v.consumerRenewal.validatedBy = ['webfinger-integration']; }, /WebFinger consumer applicable runs/],
	['wrong canonical predecessor', v => { v.predecessor.canonicalSha256 = '0'.repeat(64); }, /WebFinger predecessor identity/],
	['unvalidated receipt', v => { v.receipt.record.status = 'PENDING'; }, /WebFinger successful run/],
	['unfrozen request', v => { v.request.status = 'READY'; }, /WebFinger frozen request/],
	['free floating frozen map', v => { v.request.frozenInputMapSha256 = '0'.repeat(64); }, /WebFinger frozen map/],
	['unmeasured run totals', v => { v.receipt.record.commands[2].tests.numPassedTests = 232; }, /WebFinger successful tests/],
	['forged record without host files', v => { v.implementationCommit = '0'.repeat(40); }, /WebFinger reviewed record/],
]) test(`WebFinger rejects ${name} without host artifacts`, () => {
	const v = record(); mutate(v);
	assert.throws(() => validateLocalWebfingerEvidence(v, read, () => null), error);
});
test('WebFinger rejects both historical source evidence and the actual consumer predecessor tampering', () => {
	const v = record();
	for (const path of [v.sourceEvidence.path, v.consumerRenewal.predecessor.path]) {
		assert.throws(() => validateLocalWebfingerEvidence(v, p => p === path ? Buffer.from('tampered history') : read(p), () => null), /WebFinger .* drift/);
	}
});
test('current image projection preserves old image assertions and follows only bounded WebFinger identities', async () => {
	const { currentLocalActorImagesDigest, localActorImagesDigest } = await import('./local-actor-images-evidence.mjs');
	const v = record();
	assert.equal(localActorImagesDigest(v.file, v.previousSha256), v.previousSha256);
	assert.equal(currentLocalActorImagesDigest(v.file, v.previousSha256), v.sha256);
	assert.equal(currentLocalActorImagesDigest(v.consumerRenewal.file, v.consumerRenewal.previousSha256), v.consumerRenewal.sha256);
	const unrelated = 'packages/backend-next/src/composition/http-app.ts';
	assert.equal(currentLocalActorImagesDigest(unrelated, 'unmeasured-unrelated'), 'unmeasured-unrelated');
	assert.throws(() => currentLocalActorImagesDigest(v.file, '0'.repeat(64)), /previous identity/);
	assert.throws(() => currentLocalActorImagesDigest(v.consumerRenewal.file, '0'.repeat(64)), /previous identity/);
	assert.throws(() => currentLocalActorImagesDigest(v.file, v.previousSha256, undefined, p => p === v.file ? Buffer.from('drift') : read(p), () => null), /WebFinger .* drift/);
});

for (const [name, mutate, error] of [
	['unrelated renewal target', v => { v.sourceProbeCorrection.path = v.file; }, /WebFinger source probe correction scope/],
	['unknown probe predecessor', v => { v.sourceProbeCorrection.previousSha256 = '0'.repeat(64); }, /WebFinger source probe predecessor/],
	['failed replay', v => { v.sourceProbeCorrection.run.exitCode = 1; }, /WebFinger successful source probe replay/],
	['missing fault injection', v => { v.sourceProbeCorrection.run.metaFaultControl.getStatus = 200; }, /WebFinger source probe fault controls/],
	['changed observations', v => { v.sourceProbeCorrection.observationsSha256 = '0'.repeat(64); }, /WebFinger source probe observations drift/],
]) test(`WebFinger rejects source-only correction with ${name}`, () => {
	const v = record(); mutate(v);
	assert.throws(() => validateLocalWebfingerEvidence(v, read, () => null), error);
});
test('WebFinger checks available source-only replay log bytes', () => {
	const v = record();
	assert.throws(() => validateLocalWebfingerEvidence(v, read, p => p === v.sourceProbeCorrection.run.log ? Buffer.from('changed log') : null), /WebFinger actual source probe log bytes/);
});
