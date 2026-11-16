/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scopedEvidenceValidation, withEvidenceRequestedPath, getEvidenceCurrentReader, registerEvidenceObserver } from './evidence-validation-scope.mjs';
import { readBeforeNotesPagination } from './notes-pagination-evidence.mjs';

const directory = 'docs/superpowers/compatibility/avatar-images/';
const receiptSeal = '490de47cfab1432a900fa3f322ea97e8f858754a35558ea18f0d752cf22e3839';
const historySeals = {
  "r1-current-evidence.json": "fdff3890d970fdf3cd4287781e808301bca56d46f51dcc532a14000df2aa868f",
  "r1-predecessor.json": "bb3ff4c436f4bd16e310a42dea1be634c136694bbd4cbc932e70c6ed744ba680",
  "r2-current-evidence.json": "def91376d85e900194a83ffbd9fab5588136bb8fd0a1709e550013e224a8e7f9",
  "r2-predecessor.json": "27a4d13467e7b648ed49cc86a9f70ebe1834d7b8a221b21ebb48a944889c7bfb"
};
const observerRegistration = {};
const predecessorSeal = '27a4d13467e7b648ed49cc86a9f70ebe1834d7b8a221b21ebb48a944889c7bfb';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const optionalRead = path => {
	try {
		return readFileSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
};
export const avatarImagesPredecessorFiles = Object.freeze([
	'packages/backend-next/package.json',
	'pnpm-lock.yaml',
	'packages/backend-next/src/composition/http-app.ts',
	'packages/backend-next/test/unit/composition/http-app.test.ts',
]);

export function validateAvatarImagesEvidence(value, rawRead = read, optional = optionalRead) {
	rawRead = getEvidenceCurrentReader(rawRead);
	return scopedEvidenceValidation(validateAvatarImagesEvidence, value, rawRead, optional, (rawRead, optional) => {
		const liveRead = rawRead;
		rawRead = path => readBeforeNotesPagination(path, liveRead, optional);
		for (const [name, seal] of Object.entries(historySeals)) assert.equal(sha(rawRead(directory + name)), seal, 'avatar images historical seal');
		const receipt = rawRead(directory + 'current-evidence.json');
		assert.equal(sha(receipt), receiptSeal, 'avatar images receipt seal');
		value ??= JSON.parse(receipt);
		assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), receiptSeal, 'avatar images receipt seal');
		assert.equal(value.scope, 'avatar-images-556');
		assert.equal(value.baseRevision, 'fec2ca0f3c012a8d4491ec2327906b7d34a68b35');
		assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
		assert.equal(value.upstreamFullServerMeasured, false);
		assert.equal(value.noInputDrift, true);
		assert.deepEqual(value.inputsAfter, value.inputs);
		assert.equal(Object.keys(value.inputs).length, 14);
		for (const [path, digest] of Object.entries(value.inputs)) {
			assert.equal(sha(rawRead(path)), digest, `Meta cache measured current input drift (avatar images): ${path}`);
		}
		const bytes = rawRead(directory + 'predecessor.json');
		assert.equal(sha(bytes), predecessorSeal, 'avatar images predecessor seal');
		const previous = JSON.parse(bytes);
		assert.equal(previous.baseRevision, value.baseRevision);
		assert.deepEqual(Object.keys(previous.files), avatarImagesPredecessorFiles);
		const result = {};
		for (const path of avatarImagesPredecessorFiles) {
			const binding = previous.files[path];
			if (path !== 'pnpm-lock.yaml') {
				assert.equal(binding.currentSha256, value.inputs[path]);
			}
			assert.equal(sha(rawRead(path)), binding.currentSha256, `Meta cache measured current input drift (avatar images): ${path}`);
			let before = Buffer.from(rawRead(path));
			for (const patch of [...binding.patches].reverse()) {
				const insert = Buffer.from(patch.insert);
				assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'avatar images exact predecessor anchor');
				before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous ?? ''), before.subarray(patch.offset + insert.length)]);
			}
			assert.equal(sha(before), binding.previousSha256, 'avatar images exact predecessor identity');
			result[path] = before.toString();
		}
		assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source']);
		for (const run of value.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) {
				assert.equal(sha(log), run.logSha256, 'avatar images actual log drift');
				if (run.passed !== undefined) {
					assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
				}
			}
		}
		return result;
	});
}

// Only changed shared inputs project. Other paths retain current bytes, and
// each projected public call checks the live measured inputs before projection.
export function readPreAvatarImages(path, rawRead = read, optional = optionalRead) {
	return withEvidenceRequestedPath(path, () => {
		if (!avatarImagesPredecessorFiles.includes(path)) {
			return rawRead(path);
		}
		// Ancestor validators must observe their requested live view as well as
		// the original source checked below, so their own cache detects drift.
		rawRead(path);
		registerEvidenceObserver(observerRegistration, rawRead, () => {
			for (const [name, seal] of Object.entries(historySeals)) assert.equal(sha(rawRead(directory + name)), seal, 'avatar images historical seal');
			const receipt = rawRead(directory + 'current-evidence.json');
			assert.equal(sha(receipt), receiptSeal, 'avatar images receipt seal');
			assert.equal(sha(rawRead(directory + 'predecessor.json')), predecessorSeal, 'avatar images predecessor seal');
			for (const input of Object.keys(JSON.parse(receipt).inputs)) {
				if (input.endsWith('.json')) {
					rawRead(input);
				}
			}
		});
		return Buffer.from(validateAvatarImagesEvidence(undefined, rawRead, optional)[path]);
	});
}
