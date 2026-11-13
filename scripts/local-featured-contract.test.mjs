/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateLocalActorTagEvidence, localActorTagDigest } from './local-actor-tags-evidence.mjs';
import { validateLocalActorImagesEvidence, localActorImagesDigest, currentFeaturedActorImagesDigest } from './local-actor-images-evidence.mjs';
import { validateLocalWebfingerEvidence, localWebfingerDigest, currentLocalWebfingerDigest } from './local-webfinger-evidence.mjs';
import { localActorFieldsDigest } from './local-actor-fields-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const read = path => readFileSync(new URL(path, root));
const record = () => JSON.parse(read(directory + 'local-featured-current-evidence.json'));
const leaf = () => import('./local-featured-evidence.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('existing current tag/image/WebFinger validators accept the actual featured source bytes', () => {
	for (const [validate, name] of [
		[validateLocalActorTagEvidence, 'local-actor-tags-runtime-evidence.json'],
		[validateLocalActorImagesEvidence, 'local-actor-images-current-evidence.json'],
		[validateLocalWebfingerEvidence, 'local-webfinger-current-evidence.json'],
	]) assert.doesNotThrow(() => validate(JSON.parse(read(directory + name)), read, () => null), name);
});

test('current readers renew five bound identities while historical projections remain unchanged', async () => {
	const { localFeaturedDigest } = await leaf();
	for (const [file, binding] of Object.entries(record().files)) {
		assert.equal(localFeaturedDigest(file, binding.previousSha256, read, () => null), binding.sha256);
		assert.equal(localFeaturedDigest(file, binding.sha256, read, () => null), binding.sha256);
		assert.throws(() => localFeaturedDigest(file, '0'.repeat(64), read, () => null), /featured previous identity/);
		assert.equal(currentLocalWebfingerDigest(file, binding.previousSha256, read, () => null), binding.sha256);
		const imageRecord = JSON.parse(read(directory + 'local-actor-images-current-evidence.json'));
		assert.equal(currentFeaturedActorImagesDigest(file, imageRecord.files[file]?.sha256 ?? binding.previousSha256, undefined, read, () => null), binding.sha256);
		assert.equal(localActorFieldsDigest(file, binding.previousSha256, read, () => null), binding.previousSha256);
	}
	const webfinger = JSON.parse(read(directory + 'local-webfinger-current-evidence.json'));
	for (const binding of [webfinger, webfinger.consumerRenewal]) {
		assert.equal(localWebfingerDigest(binding.file, binding.previousSha256, read, () => null), binding.sha256);
		const images = JSON.parse(read(directory + 'local-actor-images-current-evidence.json'));
		const imageDigest = images.files[binding.file]?.sha256 ?? binding.sha256;
		assert.equal(localActorImagesDigest(binding.file, imageDigest, undefined, read, () => null), imageDigest);
	}
	for (const [file, binding] of Object.entries(record().files).filter(([p]) => p.endsWith('note-activity.ts'))) {
		assert.equal(localActorTagDigest(file, binding.previousSha256, undefined, read, () => null), binding.sha256);
	}
	assert.equal(localFeaturedDigest('unrelated', 'untouched', () => { throw Error('unexpected read'); }), 'untouched');
	assert.equal(localFeaturedDigest('packages/backend-next/src/modules/federation/local-featured.ts', 'new-file-has-no-predecessor', read, () => null), 'new-file-has-no-predecessor');
});

test('finite evidence works with actual host files or without ephemeral artifacts', async () => {
	const { validateLocalFeaturedEvidence } = await leaf();
	validateLocalFeaturedEvidence(record());
	validateLocalFeaturedEvidence(record(), read, () => null);
});

for (const [name, mutate, error] of [
	['unknown predecessor', v => { Object.values(v.files)[0].previousSha256 = '0'.repeat(64); }, /featured predecessor identity/],
	['null predecessor', v => { Object.values(v.files)[0].previousSha256 = null; }, /featured predecessor identity/],
	['unbound renewal', v => { v.files.unrelated = Object.values(v.files)[0]; }, /featured renewal subset/],
	['missing renewal', v => { delete v.files[Object.keys(v.files)[0]]; }, /featured renewal subset/],
	['unfrozen input', v => { delete v.frozenInputSha256[Object.keys(v.files)[0]]; }, /featured frozen subset/],
	['missing measurement', v => { Object.values(v.files)[0].validatedBy = []; }, /featured applicable runs/],
	['inapplicable measurement', v => { Object.values(v.files)[0].validatedBy = ['source-probe']; }, /featured applicable runs/],
	['missing run', v => { v.receipt.record.commands.pop(); }, /featured required runs/],
	['failed run', v => { v.receipt.record.commands[0].exitCode = 1; }, /featured successful run/],
	['failed receipt', v => { v.receipt.record.status = 'FAIL'; }, /featured successful receipt/],
	['failed tests', v => { v.receipt.record.commands[4].tests.numFailedTests = 1; }, /featured successful tests/],
	['skipped tests', v => { v.receipt.record.commands[5].tests.numPendingTests = 1; }, /featured successful tests/],
	['missing test counts', v => { delete v.receipt.record.commands[4].tests; }, /featured successful tests/],
	['partial count', v => { v.receipt.record.commands[4].tests.numPassedTests--; }, /featured successful tests/],
	['missing artifact', v => { delete v.receipt.record.commands[4].artifact; }, /featured test artifact/],
	['changed command', v => { v.receipt.record.commands[0].command = 'true'; }, /featured canonical record/],
	['empty command', v => { v.receipt.record.commands[0].command = ''; }, /featured successful run/],
	['missing log hash', v => { delete v.receipt.record.commands[0].logSha256; }, /featured log hash/],
	['request mismatch', v => { v.request.sha256 = '0'.repeat(64); }, /featured request binding/],
	['full map mismatch', v => { v.request.frozenInputMapSha256 = '0'.repeat(64); }, /featured canonical record/],
	['bad time', v => { v.receipt.record.completedAt = 'invalid'; }, /featured measurement window/],
	['reversed time', v => { v.receipt.record.completedAt = '2026-11-12T00:00:00Z'; }, /featured measurement window/],
	['source hash', v => { v.sourceOracle.manifestSha256 = '0'.repeat(64); }, /featured source provenance/],
	['source count', v => { v.sourceOracle.caseCount--; }, /featured source count/],
	['skipped source', v => { v.logMeasurements['source-probe'].skipped = 1; }, /featured log measurements/],
	['missing upstream measurement', v => { delete v.logMeasurements['upstream-tests']; }, /featured log measurements/],
	['wrong base', v => { v.baseCommit = '0'.repeat(40); }, /featured request binding/],
	['wrong product pin', v => { v.implementationCommit = '0'.repeat(40); }, /featured canonical record/],
	['posting promotion', v => { v.postingComplete = true; }, /posting remains partial/],
	['full upstream claim', v => { v.upstreamFullServerMeasured = true; }, /source is not full server/],
]) test(`featured rejects ${name} without host artifacts`, async () => {
	const { validateLocalFeaturedEvidence } = await leaf();
	const value = record(); mutate(value);
	assert.throws(() => validateLocalFeaturedEvidence(value, read, () => null), error);
});

test('all selected source, fixtures, corpus, observations and immutable predecessor bytes reject corruption', async () => {
	const { validateLocalFeaturedEvidence } = await leaf();
	const value = record();
	for (const path of new Set([...Object.keys(value.frozenInputSha256), ...Object.values(value.files).map(v => v.predecessor.path)])) {
		assert.throws(() => validateLocalFeaturedEvidence(value, p => p === path ? Buffer.from('corrupt') : read(p), () => null), /featured .* drift/, path);
	}
});

test('injected current reader reaches leaf through existing helper chain', () => {
	const value = record();
	for (const [file, binding] of Object.entries(value.files)) {
		let reads = 0;
		const injected = path => { if (path === file) { reads++; return Buffer.from('corrupt'); } return read(path); };
		assert.throws(() => currentLocalWebfingerDigest(file, binding.previousSha256, injected, () => null), /featured current input drift|WebFinger measured input drift/);
		assert(reads > 0, file);
	}
});

test('current record byte corruption is rejected by the digest entry point', async () => {
	const { localFeaturedDigest } = await leaf();
	const value = record(); value.receipt.sha256 = '0'.repeat(64);
	const [file, binding] = Object.entries(value.files)[0];
	assert.throws(() => localFeaturedDigest(file, binding.previousSha256, p => p.endsWith('local-featured-current-evidence.json') ? JSON.stringify(value) : read(p), () => null), /featured canonical record/);
});

test('optional host request, receipt, command logs and artifacts verify exact bytes', async () => {
	const { validateLocalFeaturedEvidence } = await leaf();
	const value = record();
	for (const path of [value.request.path, value.receipt.path, ...value.receipt.record.commands.flatMap(c => [c.log, c.artifact].filter(Boolean))]) {
		assert.throws(() => validateLocalFeaturedEvidence(value, read, p => p === path ? Buffer.from('{}') : null), /featured actual .* bytes/, path);
	}
});

test('leaf imports only Node and never invokes an ancestor helper or global validator', () => {
	const source = read('scripts/local-featured-evidence.mjs').toString();
	const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
	assert(imports.length > 0 && imports.every(p => p.startsWith('node:')));
	assert(!/import\(|execFile|spawn|validateLocalActor|localActor.*Digest/.test(source));
	assert.equal(sha(read(directory + 'local-featured-corpus.json')), record().sourceOracle.corpusSha256);
});


test('record whitespace changes also reject at the exact-byte entry point', async () => {
	const { localFeaturedDigest } = await leaf();
	const [file, binding] = Object.entries(record().files)[0];
	assert.throws(() => localFeaturedDigest(file, binding.previousSha256, p => p.endsWith('local-featured-current-evidence.json') ? Buffer.concat([read(p), Buffer.from(' ')]) : read(p), () => null), /featured record bytes/);
});

test('tag, image and WebFinger validators propagate injected current bytes', () => {
	const file = 'packages/backend-next/src/modules/federation/public.ts';
	for (const [validate, name] of [
		[validateLocalActorTagEvidence, 'local-actor-tags-runtime-evidence.json'],
		[validateLocalActorImagesEvidence, 'local-actor-images-current-evidence.json'],
		[validateLocalWebfingerEvidence, 'local-webfinger-current-evidence.json'],
	]) {
		let reads = 0;
		const injected = path => { if (path === file) { reads++; return Buffer.from('corrupt'); } return read(path); };
		assert.throws(() => validate(JSON.parse(read(directory + name)), injected, () => null), /WebFinger measured input drift|featured current input drift/);
		assert(reads > 0, name);
	}
});
