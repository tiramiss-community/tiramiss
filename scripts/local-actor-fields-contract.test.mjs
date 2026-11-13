/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { currentLocalActorImagesDigest, localActorImagesDigest } from './local-actor-images-evidence.mjs';
import { localWebfingerDigest, validateLocalWebfingerEvidence } from './local-webfinger-evidence.mjs';
import { validateRemoteEmojiEvidence } from './remote-emojis-evidence.mjs';
import { validateLocalActorTagEvidence } from './local-actor-tags-evidence.mjs';
import { validateRemoteProfileEvidence } from './remote-profile-evidence.mjs';
import { validateActorImageRemovalEvidence } from './actor-image-removal-evidence.mjs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const read = path => readFileSync(new URL(path, root));
const record = () => JSON.parse(read(directory + 'local-actor-fields-current-evidence.json'));
const leaf = () => import('./local-actor-fields-evidence.mjs');

test('current image consumers reach measured fields bytes while historical image projections retain their identities', () => {
	const value = record();
	for (const [file, binding] of Object.entries(value.files)) {
		assert.equal(localActorImagesDigest(file, binding.previousSha256, undefined, read, () => null), binding.previousSha256);
		assert.equal(currentLocalActorImagesDigest(file, binding.previousSha256, undefined, read, () => null), binding.sha256);
	}
});

test('injected current bytes propagate through every earlier validator to the leaf without recursion', () => {
	const file = 'packages/backend-next/src/modules/federation/local-actor.ts';
	for (const [validate, name] of [
		[validateRemoteEmojiEvidence, 'remote-emojis-runtime-evidence.json'],
		[validateLocalActorTagEvidence, 'local-actor-tags-runtime-evidence.json'],
		[validateRemoteProfileEvidence, 'remote-profile-runtime-evidence.json'],
		[validateActorImageRemovalEvidence, 'actor-image-removal-current-evidence.json'],
	]) {
		let reads = 0;
		const injected = path => {
			if (path === file) { reads++; return Buffer.from('injected drift'); }
			return read(path);
		};
		assert.throws(() => validate(JSON.parse(read(directory + name)), injected, () => null), /fields current input drift/, name);
		assert(reads > 0, name);
	}
});

test('WebFinger retains its own byte checks and passes unrelated measured fields to the leaf', () => {
	const value = JSON.parse(read(directory + 'local-webfinger-current-evidence.json'));
	assert.throws(() => validateLocalWebfingerEvidence(value, p => p === value.file ? Buffer.from('drift') : read(p), () => null), /WebFinger measured input drift/);
	const file = Object.keys(record().files)[0];
	const binding = record().files[file];
	assert.throws(() => localWebfingerDigest(file, binding.previousSha256, p => p === file ? Buffer.from('drift') : read(p), () => null), /fields current input drift/);
});

test('finite leaf validates actual provenance with host artifacts present or absent', async () => {
	const { validateLocalActorFieldsEvidence, localActorFieldsDigest } = await leaf();
	const value = record();
	validateLocalActorFieldsEvidence(value);
	validateLocalActorFieldsEvidence(value, read, () => null);
	for (const [file, binding] of Object.entries(value.files)) {
		for (const digest of [binding.previousSha256, binding.sha256]) {
			assert.equal(localActorFieldsDigest(file, digest, read, () => null), binding.sha256);
		}
		assert.throws(() => localActorFieldsDigest(file, '0'.repeat(64), read, () => null), /fields previous identity/);
	}
	assert.equal(localActorFieldsDigest('unrelated', 'untouched', read, () => null), 'untouched');
	// Newly added tests have measured bytes but no predecessor to renew.
	const added = 'packages/backend-next/test/unit/federation/local-actor-fields.test.ts';
	assert.equal(localActorFieldsDigest(added, 'no historical binding', read, () => null), 'no historical binding');
});

for (const [name, mutate, error] of [
	['unknown predecessor', v => { Object.values(v.files)[0].previousSha256 = '0'.repeat(64); }, /fields predecessor identity/],
	['unbound renewal', v => { v.files.unrelated = Object.values(v.files)[0]; }, /fields renewal subset/],
	['missing renewal', v => { delete v.files[Object.keys(v.files)[0]]; }, /fields renewal subset/],
	['unfrozen bytes', v => { delete v.frozenInputSha256[Object.keys(v.files)[0]]; }, /fields frozen subset/],
	['missing applicable measurement', v => { Object.values(v.files)[0].validatedBy = []; }, /fields applicable runs/],
	['inapplicable measurement', v => { Object.values(v.files)[0].validatedBy = ['source-check']; }, /fields applicable runs/],
	['invented measurement', v => { Object.values(v.files)[0].validatedBy.push('imaginary'); }, /fields applicable runs/],
	['missing run', v => { v.receipt.record.commands.splice(3, 1); }, /fields required runs/],
	['failed run', v => { v.receipt.record.commands[0].exitCode = 1; }, /fields successful run/],
	['non-PASS receipt', v => { v.receipt.record.status = 'FAIL'; }, /fields successful receipt/],
	['failed tests', v => { v.receipt.record.commands[3].tests.numFailedTests = 1; }, /fields successful tests/],
	['skipped tests', v => { v.receipt.record.commands[4].tests.numPendingTests = 1; }, /fields successful tests/],
	['partial count', v => { v.receipt.record.commands[3].tests.numPassedTests--; }, /fields successful tests/],
	['missing artifact', v => { delete v.receipt.record.commands[3].artifact; }, /fields test artifact/],
	['request provenance', v => { v.request.sha256 = '0'.repeat(64); }, /fields request binding/],
	['map provenance', v => { v.request.frozenInputMapSha256 = '0'.repeat(64); }, /fields canonical record/],
	['bad window', v => { v.receipt.record.completedAt = 'invalid'; }, /fields measurement window/],
	['source method provenance', v => { v.sourceOracle.manifest.methods.renderPerson = '0'.repeat(64); }, /fields source binding/],
	['wrong source count', v => { v.sourceOracle.caseCount = 20; }, /fields source binding/],
	['wrong product pin', v => { v.implementationCommit = '0'.repeat(40); }, /fields canonical record/],
	['posting promotion', v => { v.postingComplete = true; }, /posting remains partial/],
	['upstream server claim', v => { v.upstreamFullServerMeasured = true; }, /source is not full server/],
]) {
	test(`fields rejects ${name} even without host files`, async () => {
		const { validateLocalActorFieldsEvidence } = await leaf();
		const value = record(); mutate(value);
		assert.throws(() => validateLocalActorFieldsEvidence(value, read, () => null), error);
	});
}

test('leaf rejects drift of every measured input and immutable predecessor', async () => {
	const { validateLocalActorFieldsEvidence } = await leaf();
	const value = record();
	for (const path of [...Object.keys(value.frozenInputSha256), value.predecessor.path, value.webfingerEvidence.path]) {
		assert.throws(() => validateLocalActorFieldsEvidence(value, p => p === path ? Buffer.from('drift') : read(p), () => null), /fields .* drift/, path);
	}
});

test('available host request, receipt, logs and artifacts are byte checked', async () => {
	const { validateLocalActorFieldsEvidence } = await leaf();
	const value = record();
	for (const path of [value.request.path, value.receipt.path, ...value.receipt.record.commands.flatMap(c => [c.log, c.artifact].filter(Boolean))]) {
		assert.throws(() => validateLocalActorFieldsEvidence(value, read, p => p === path ? Buffer.from('{}') : null), /fields actual .* bytes/, path);
	}
});
