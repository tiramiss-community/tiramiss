/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const record = () => JSON.parse(read('docs/superpowers/compatibility/remote-user/local-actor-images-current-evidence.json'));
const file = 'packages/backend-next/src/composition/remote-users.ts';
const helper = () => import('./local-actor-images-evidence.mjs');

test('image renewal binds actual R2 runs and preserves finite predecessors without host files', async () => {
	const { validateLocalActorImagesEvidence, localActorImagesDigest } = await helper();
	const value = record();
	validateLocalActorImagesEvidence(value);
	validateLocalActorImagesEvidence(value, read, () => null);
	for (const [path, binding] of Object.entries(value.files)) {
		if (binding.previousSha256) assert.equal(localActorImagesDigest(path, binding.previousSha256), binding.sha256);
		assert.equal(localActorImagesDigest(path, binding.sha256), binding.sha256);
	}
	assert.equal(localActorImagesDigest('unaffected', 'old'), 'old');
	assert.throws(() => localActorImagesDigest(file, '0'.repeat(64)), /previous identity/);
	assert.throws(() => localActorImagesDigest('packages/backend-next/src/composition/local-actor-materials.ts', '0'.repeat(64)), /previous identity/);
});
for (const [name, mutate, error] of [
	['premature completion', v => { v.postingComplete = true; }, /posting remains partial/],
	['unfrozen current file', v => { delete v.frozenInputSha256[file]; }, /binding was frozen/],
	['unvalidated current file', v => { v.files[file].validatedBy = []; }, /applicable successful run/],
	['inapplicable successful run', v => { v.files[file].validatedBy = ['source-check']; }, /applicable successful run/],
	['unknown validating run', v => { v.files[file].validatedBy = ['invented']; }, /applicable successful run/],
	['failed run', v => { v.receipt.record.commands[0].exitCode = 1; }, /successful image run/],
	['missing HTTP PG run', v => { v.receipt.record.commands.splice(3, 1); }, /required image runs/],
	['failed tests', v => { v.receipt.record.commands[2].tests.numFailedTests = 1; }, /successful image tests/],
	['skipped tests', v => { v.receipt.record.commands[3].tests.numPendingTests = 1; }, /successful image tests/],
	['invented predecessor', v => { v.files[file].previousSha256 = '0'.repeat(64); }, /reviewed image record/],
	['incorrect frozen map', v => { v.request.frozenInputMapSha256 = '0'.repeat(64); }, /historical image frozen map/],
	['malformed source binding', v => { v.sourceOracle.manifest[0].methods.renderImage = '0'.repeat(64); }, /source oracle binding/],
	['invented upstream HTTP measurement', v => { v.upstreamHttpMeasured = true; }, /source methods are not upstream HTTP/],
]) test(`image renewal rejects ${name} without host artifacts`, async () => {
	const { validateLocalActorImagesEvidence } = await helper();
	const value = record(); mutate(value);
	assert.throws(() => validateLocalActorImagesEvidence(value, read, () => null), error);
});
test('image renewal rejects changed bytes including source oracle and immutable predecessor', async () => {
	const { validateLocalActorImagesEvidence } = await helper();
	const value = record();
	for (const path of [file, value.historicalEvidence.path, value.predecessorEvidence.path, ...Object.keys(value.files).filter(p => p.startsWith('docs/'))]) {
		assert.throws(() => validateLocalActorImagesEvidence(value, p => p === path ? Buffer.from('drift') : read(p), () => null), /renewal .* drift/);
	}
});
test('image renewal checks available actual request receipt logs and artifacts', async () => {
	const { validateLocalActorImagesEvidence } = await helper();
	const value = record();
	for (const path of [value.request.path, value.receipt.path, ...value.receipt.record.commands.flatMap(c => [c.log, c.artifact].filter(Boolean))]) {
		assert.throws(() => validateLocalActorImagesEvidence(value, read, p => p === path ? Buffer.from('{}') : null), /actual image .* bytes/);
	}
});
