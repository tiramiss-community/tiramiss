/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const record = () => JSON.parse(readFileSync(new URL('../docs/superpowers/compatibility/remote-user/actor-image-removal-current-evidence.json', import.meta.url)));
const file = 'packages/backend-next/src/composition/remote-users.ts';
const helper = () => import('./actor-image-removal-evidence.mjs');

test('renewal projects measured bytes with or without optional host artifacts', async () => {
	const { validateActorImageRemovalEvidence, actorImageRemovalDigest } = await helper();
	const value = record();
	validateActorImageRemovalEvidence(value);
	validateActorImageRemovalEvidence(value, undefined, () => null);
	for (const [path, binding] of Object.entries(value.files)) {
		assert.equal(actorImageRemovalDigest(path, binding.previousSha256), binding.sha256);
		assert.equal(actorImageRemovalDigest(path, binding.sha256), binding.sha256);
	}
	assert.equal(actorImageRemovalDigest('unaffected', 'old'), 'old');
});
for (const [name, mutate, error] of [
	['premature completion', v => { v.postingComplete = true; }, /posting remains partial/],
	['failed run', v => { v.receipt.record.commands[0].exitCode = 1; }, /successful renewal run/],
	['invented digest', v => { v.files[file].sha256 = '0'.repeat(64); }, /renewal binding was frozen/],
	['unfrozen file', v => { delete v.frozenInputSha256[file]; }, /renewal binding was frozen/],
	['unvalidated file', v => { v.files[file].validatedBy = []; }, /relevant renewal runs/],
	['missing integration', v => { v.receipt.record.commands = v.receipt.record.commands.filter(c => c.id !== 'integration'); }, /successful renewal run/],
	['failed tests', v => { v.receipt.record.commands.find(c => c.id === 'unit').tests.numFailedTests = 1; }, /successful selected tests/],
	['invented predecessor', v => { v.files[file].previousSha256 = '0'.repeat(64); }, /reviewed renewal record/],
	['free floating counts', v => { v.receipt.record.frozenInputs = 10; }, /frozen request count/],
]) {
	test(`renewal rejects ${name} without host artifacts`, async () => {
		const { validateActorImageRemovalEvidence } = await helper();
		const value = record(); mutate(value);
		assert.throws(() => validateActorImageRemovalEvidence(value, undefined, () => null), error);
	});
}
test('renewal rejects wrong predecessor before validating the hop', async () => {
	const { actorImageRemovalDigest } = await helper();
	assert.throws(() => actorImageRemovalDigest(file, '0'.repeat(64), 'expected predecessor'), /expected predecessor/);
});
test('renewal checks available raw request and receipt bytes', async () => {
	const { validateActorImageRemovalEvidence } = await helper();
	for (const key of ['request', 'receipt']) {
		const value = record();
		assert.throws(() => validateActorImageRemovalEvidence(value, undefined, path => path === value[key].path ? Buffer.from('{}') : null), /actual renewal .* bytes/);
	}
});
test('renewal rejects drift in measured files and historical evidence', async () => {
	const { validateActorImageRemovalEvidence } = await helper();
	const value = record();
	for (const changed of [file, value.historicalEvidence.path, value.predecessorEvidence.path]) {
		assert.throws(() => validateActorImageRemovalEvidence(value, path => path === changed ? Buffer.from('drift') : readFileSync(new URL('../' + path, import.meta.url)), () => null), /renewal .* drift/);
	}
});
