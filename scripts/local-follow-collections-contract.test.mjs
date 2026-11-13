/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadFollowCollectionsR2History } from './local-follow-collections-history.mjs';
import * as currentLeaf from './local-follow-collections-evidence.mjs';
import test from 'node:test';
import { localFollowCollectionsDigest, validateLocalFollowCollectionsEvidence } from './local-follow-collections-evidence.mjs';
import { localFeaturedDigest, validateLocalFeaturedEvidence } from './local-featured-evidence.mjs';
import { localActorFieldsDigest, currentLocalActorFieldsDigest } from './local-actor-fields-evidence.mjs';
import { localWebfingerDigest, currentLocalWebfingerDigest, validateLocalWebfingerEvidence } from './local-webfinger-evidence.mjs';
import { localActorImagesDigest, currentFeaturedActorImagesDigest, validateLocalActorImagesEvidence } from './local-actor-images-evidence.mjs';
import { validateLocalActorTagEvidence } from './local-actor-tags-evidence.mjs';
import { validateRemoteProfileEvidence } from './remote-profile-evidence.mjs';
import { validateActorImageRemovalEvidence } from './actor-image-removal-evidence.mjs';
import { validateRemoteEmojiEvidence } from './remote-emojis-evidence.mjs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const path = directory + 'local-follow-collections-path-current-evidence.json';
const r2Path = directory + 'local-follow-collections-current-evidence.json';
const read = file => readFileSync(new URL(file, root));
const json = file => JSON.parse(read(file));
const record = () => json(path);
const absent = () => null;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual R3b proof validates with host artifacts and when ephemeral files are absent', () => {
	validateLocalFollowCollectionsEvidence(record());
	validateLocalFollowCollectionsEvidence(record(), read, absent);
});

test('only three measured identities renew; historical projections stay at their original hop', () => {
	const value = record();
	assert.equal(Object.keys(value.files).length, 3);
	const featured = json(directory + 'local-featured-current-evidence.json');
	for (const [file, binding] of Object.entries(value.files)) {
		for (const digest of [binding.previousSha256, binding.sha256]) assert.equal(localFollowCollectionsDigest(file, digest, read, absent), binding.sha256);
		assert.equal(localFeaturedDigest(file, featured.files[file].previousSha256, read, absent), binding.previousSha256);
		assert.equal(localActorFieldsDigest(file, binding.previousSha256, read, absent), binding.previousSha256);
		assert.equal(localWebfingerDigest(file, featured.files[file].previousSha256, read, absent), featured.files[file].previousSha256);
		const imageDigest = json(directory + 'local-actor-images-current-evidence.json').files[file]?.sha256 ?? featured.files[file].previousSha256;
		assert.equal(localActorImagesDigest(file, imageDigest, undefined, read, absent), imageDigest);
		for (const current of [currentLocalActorFieldsDigest, currentLocalWebfingerDigest]) assert.equal(current(file, featured.files[file].previousSha256, read, absent), binding.sha256);
		assert.equal(currentFeaturedActorImagesDigest(file, imageDigest, undefined, read, absent), binding.sha256);
		assert.throws(() => localFollowCollectionsDigest(file, '0'.repeat(64), read, absent), /follow collections previous identity/);
	}
	for (const file of ['unrelated', 'packages/backend-next/src/modules/federation/local-follow-collections.ts']) {
		assert.equal(localFollowCollectionsDigest(file, 'unchanged', () => { throw Error('unexpected read'); }), 'unchanged');
	}
});

for (const [name, mutate, error] of [
	['unknown predecessor', v => { Object.values(v.files)[0].previousSha256 = '0'.repeat(64); }, /predecessor identity/],
	['null predecessor', v => { Object.values(v.files)[0].previousSha256 = null; }, /predecessor identity/],
	['predecessor pointer', v => { Object.values(v.files)[0].predecessor.pointer = ['files']; }, /predecessor binding/],
	['predecessor path', v => { Object.values(v.files)[0].predecessor.path = 'unrelated'; }, /predecessor binding/],
	['predecessor bytes', v => { Object.values(v.files)[0].predecessor.sha256 = '0'.repeat(64); }, /predecessor binding/],
	['invented renewal', v => { v.files.unrelated = Object.values(v.files)[0]; }, /renewal subset/],
	['new file with invented predecessor', v => { v.files['packages/backend-next/src/modules/federation/local-follow-collections.ts'] = Object.values(v.files)[0]; }, /renewal subset/],
	['missing frozen input', v => { delete v.frozenInputSha256[Object.keys(v.files)[0]]; }, /frozen subset/],
	['unmeasured bytes', v => { Object.values(v.files)[0].sha256 = '0'.repeat(64); }, /frozen identity/],
	['missing measurement', v => { Object.values(v.files)[0].validatedBy = []; }, /applicable runs/],
	['wrong measurement', v => { Object.values(v.files)[0].validatedBy = ['source-probe']; }, /applicable runs/],
	['failed receipt', v => { v.receipt.record.status = 'FAIL'; }, /successful receipt/],
	['wrong frozen count', v => { v.receipt.record.frozenInputs--; }, /frozen count/],
	['wrong request count', v => { v.request.frozenInputs--; }, /frozen count/],
	['unready request', v => { v.request.status = 'PENDING'; }, /frozen request/],
	['request hash', v => { v.request.sha256 = '0'.repeat(64); }, /request binding/],
	['request path', v => { v.request.path += '-wrong'; }, /request binding/],
	['full map digest', v => { v.request.frozenInputMapSha256 = '0'.repeat(64); }, /full map binding/],
	['receipt byte hash', v => { v.receipt.sha256 = '0'.repeat(64); }, /canonical record/],
	['wrong base', v => { v.baseCommit = '0'.repeat(40); }, /request binding/],
	['wrong product', v => { v.implementationCommit = '0'.repeat(40); }, /canonical record/],
	['missing run', v => { v.receipt.record.runs.pop(); }, /required runs/],
	['changed command', v => { v.receipt.record.runs[0].command = ['true']; }, /commands binding/],
	['rebound command', v => { v.receipt.record.runs[0].command = v.request.commands[0].command = ['true']; }, /canonical record/],
	['failed run', v => { v.receipt.record.runs[0].exitCode = 1; }, /successful run/],
	['input drift during run', v => { v.receipt.record.runs[0].frozenInputsUnchanged = false; }, /zero input drift/],
	['skipped tests', v => { v.receipt.record.runs[4].tests.numPendingTests = 1; }, /successful tests/],
	['failed tests', v => { v.receipt.record.runs[5].tests.numFailedTests = 1; }, /successful tests/],
	['changed test count', v => { v.receipt.record.runs[4].tests.numPassedTests--; }, /successful tests/],
	['missing artifact', v => { delete v.receipt.record.runs[4].artifact; }, /test artifact/],
	['missing log hash', v => { delete v.receipt.record.runs[0].logSha256; }, /log hash/],
	['wrong runtime', v => { v.receipt.record.runtime = 'v24.20.0'; }, /runtime/],
	['invalid time', v => { v.receipt.record.completedAt = 'invalid'; }, /measurement window/],
	['run outside window', v => { v.receipt.record.runs[0].startedAt = '2026-11-12T00:00:00Z'; }, /run window/],
	['skipped source', v => { v.logMeasurements['source-probe'].skipped = 1; }, /log measurements/],
	['wrong source count', v => { v.sourceOracle.caseCount = 80; }, /source count/],
	['source provenance', v => { v.sourceOracle.manifestSha256 = '0'.repeat(64); }, /source provenance/],
	['wrong PG count', v => { v.testFileMeasurements['packages/backend-next/test/integration/local-follow-collections-http.test.ts'].passed--; }, /PG HTTP count/],
	['wrong ports', v => { v.validationContext.ports.postgres++; }, /validation context/],
	['CI claim', v => { v.validationContext.ciMeasured = true; }, /validation context/],
	['posting promotion', v => { v.postingComplete = true; }, /posting remains partial/],
	['full upstream claim', v => { v.upstreamFullServerMeasured = true; }, /source is not full server/],
]) test(`follow collections rejects ${name} without host artifacts`, () => {
	const value = record(); mutate(value);
	assert.throws(() => validateLocalFollowCollectionsEvidence(value, read, absent), error);
});

test('every selected input and immutable predecessor rejects byte drift', () => {
	const value = record();
	for (const file of new Set([...Object.keys(value.frozenInputSha256), ...Object.values(value.files).map(v => v.predecessor.path)])) {
		assert.throws(() => validateLocalFollowCollectionsEvidence(value, p => p === file ? Buffer.from('corrupt') : read(p), absent), /follow collections .* drift/, file);
	}
});

test('record semantic and exact-byte tampering reject through the digest entry', () => {
	const [file, binding] = Object.entries(record().files)[0];
	const value = record(); value.receipt.sha256 = '0'.repeat(64);
	assert.throws(() => localFollowCollectionsDigest(file, binding.previousSha256, p => p === path ? JSON.stringify(value) : read(p), absent), /canonical record/);
	assert.throws(() => localFollowCollectionsDigest(file, binding.previousSha256, p => p === path ? Buffer.concat([read(p), Buffer.from(' ')]) : read(p), absent), /record bytes/);
});

test('optional actual request, receipt, all logs and artifacts reject tampered bytes', () => {
	const value = record();
	for (const file of [value.request.path, value.receipt.path, ...value.receipt.record.runs.flatMap(r => [r.log, r.artifact].filter(Boolean))]) {
		assert.throws(() => validateLocalFollowCollectionsEvidence(value, read, p => p === file ? Buffer.from('{}') : null), /follow collections actual .* bytes/, file);
	}
});

test('featured, WebFinger, image, tags, profile, image removal and emoji validators reach the new leaf', () => {
	const validators = [
		[validateLocalFeaturedEvidence, 'local-featured-current-evidence.json'],
		[validateLocalWebfingerEvidence, 'local-webfinger-current-evidence.json'],
		[validateLocalActorImagesEvidence, 'local-actor-images-current-evidence.json'],
		[validateLocalActorTagEvidence, 'local-actor-tags-runtime-evidence.json'],
		[validateRemoteProfileEvidence, 'remote-profile-runtime-evidence.json'],
		[validateActorImageRemovalEvidence, 'actor-image-removal-current-evidence.json'],
		[validateRemoteEmojiEvidence, 'remote-emojis-runtime-evidence.json'],
	];
	const product = 'packages/backend-next/src/http/activitypub-follow-collections-api.ts';
	for (const [validate, name] of validators) {
		validate(json(directory + name), read, absent);
		let reads = 0;
		const injected = p => { if (p === product) { reads++; return Buffer.from('corrupt'); } return read(p); };
		assert.throws(() => validate(json(directory + name), injected, absent), /input drift/, name);
		assert(reads > 0, name);
		assert.throws(() => validate(json(directory + name), p => p === path ? Buffer.concat([read(p), Buffer.from(' ')]) : read(p), absent), /follow collections record bytes/, name);
	}
});

test('new evidence leaf uses only Node builtins and has no ancestor calls or process tools', () => {
	const source = read('scripts/local-follow-collections-evidence.mjs').toString();
	const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
	assert(imports.length > 0 && imports.every(p => p.startsWith('node:')));
	assert(!/import\(|execFile|spawn|validateLocalFeatured|localFeaturedDigest|localActor.*Digest|validateLocalActor/.test(source));
	assert.equal(sha(read(directory + 'local-featured-current-evidence.json')), Object.values(record().files)[0].predecessor.sha256);
});


test('R2 bytes, canonical seal, receipt and original validator remain usable as actual history', async () => {
	const history = loadFollowCollectionsR2History();
	const original = history.validator;
	const historical = await import('data:text/javascript;base64,' + Buffer.from(original.replace("const root = new URL('../', import.meta.url);", `const root = new URL(${JSON.stringify(root.href)});`)).toString('base64'));
	const r2 = json(r2Path);
	const historicalRead = history.read;
	assert.equal(sha(read(r2Path)), currentLeaf.r2Seals.bytesSha256);
	assert.equal(sha(JSON.stringify(r2)), currentLeaf.r2Seals.canonicalSha256);
	historical.validateLocalFollowCollectionsEvidence(r2, historicalRead, absent);
	assert.throws(() => historical.validateLocalFollowCollectionsEvidence(r2, read, absent), /input drift/);
	const failed = structuredClone(r2); failed.receipt.record.status = 'FAIL';
	assert.throws(() => historical.validateLocalFollowCollectionsEvidence(failed, historicalRead, absent), /successful receipt/);
	const first = Object.keys(r2.frozenInputSha256)[0];
	assert.throws(() => historical.validateLocalFollowCollectionsEvidence(r2, p => p === first ? Buffer.from('corrupt') : historicalRead(p), absent), /input drift/);
	assert.deepEqual(record().files, r2.files, 'three featured-hop bindings remain identical');
});

for (const [name, mutate, error] of [
	['R2 byte seal', v => { v.previousMeasurement.sha256 = '0'.repeat(64); }, /previous measurement binding/],
	['R2 receipt binding', v => { v.previousMeasurement.receipt.requestSha256 = '0'.repeat(64); }, /previous measurement binding/],
	['missing changed input', v => { delete v.changedInputs[Object.keys(v.changedInputs)[0]]; }, /changed input subset/],
	['invented changed input', v => { v.changedInputs.unrelated = Object.values(v.changedInputs)[0]; }, /changed input subset/],
	['unknown changed predecessor', v => { Object.values(v.changedInputs)[0].previousSha256 = '0'.repeat(64); }, /changed predecessor identity/],
	['changed predecessor pointer', v => { Object.values(v.changedInputs)[0].predecessor.pointer = ['files']; }, /changed predecessor binding/],
	['unmeasured changed bytes', v => { Object.values(v.changedInputs)[0].sha256 = '0'.repeat(64); }, /changed frozen identity/],
	['unmeasured changed validation', v => { Object.values(v.changedInputs)[0].validatedBy = []; }, /changed applicable runs/],
	['missing complete-map change', v => { delete v.requestChanges[Object.keys(v.requestChanges)[0]]; }, /request change subset/],
	['false complete-map predecessor', v => { Object.values(v.requestChanges)[0].previousSha256 = '0'.repeat(64); }, /canonical record|actual previous request changes/],
	['unbound complete map', v => { v.request.inputSha256.unrelated = '0'.repeat(64); }, /full map binding/],
	['lookup instrumentation', v => { v.sourceOracle.lookupInstrumentationSha256 = '0'.repeat(64); }, /source instrumentation/],
	['old source outcome projection', v => { v.sourceOracle.originalCaseProjectionSha256 = '0'.repeat(64); }, /original source outcomes/],
]) test(`path measurement rejects ${name} without host artifacts`, () => {
	const value = record(); mutate(value);
	assert.throws(() => validateLocalFollowCollectionsEvidence(value, read, absent), error);
});

test('R2 historical record byte corruption rejects even when temporary host files are absent', () => {
	assert.throws(() => validateLocalFollowCollectionsEvidence(record(), p => p === r2Path ? Buffer.concat([read(p), Buffer.from(' ')]) : read(p), absent), /previous measurement bytes/);
});

test('available previous R2 request and receipt must match sealed historical bindings', () => {
	const value = record();
	for (const file of [value.previousMeasurement.request.path, value.previousMeasurement.receipt.path]) {
		assert.throws(() => validateLocalFollowCollectionsEvidence(value, read, p => p === file ? Buffer.from('{}') : null), /actual previous .* bytes/);
	}
});
