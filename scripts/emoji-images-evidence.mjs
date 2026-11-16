/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readPreAvatarImages } from './avatar-images-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scopedEvidenceValidation, withEvidenceRequestedPath, getEvidenceCurrentReader, registerEvidenceObserver } from './evidence-validation-scope.mjs';
import { readPreMetaInitialization } from './meta-initialization-evidence.mjs';

const directory = 'docs/superpowers/compatibility/emoji-images/';
const receiptSeal = 'e34dbaf1c3a5d450d65bb0959025e914f10f3e34e191aafc78087b6062bd5264';
const observerRegistration = {};
const predecessorSeal = '369fbb0b82b0ff12c8345dbd235e5f27c614aa31b27887f08ee1793ff6cfca08';
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
export const emojiImagesPredecessorFiles = Object.freeze([
	'packages/backend-next/package.json',
	'pnpm-lock.yaml',
	'packages/backend-next/src/composition/http-app.ts',
	'packages/backend-next/test/unit/composition/http-app.test.ts',
]);

export function validateEmojiImagesEvidence(value, rawRead = read, optional = optionalRead) {
	rawRead = getEvidenceCurrentReader(rawRead);
	return scopedEvidenceValidation(validateEmojiImagesEvidence, value, rawRead, optional, (rawRead, optional) => {
		const currentRead = rawRead;
		rawRead = path => readPreAvatarImages(path, currentRead, optional);
		const receipt = rawRead(directory + 'current-evidence.json');
		assert.equal(sha(receipt), receiptSeal, 'emoji images receipt seal');
		value ??= JSON.parse(receipt);
		assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), receiptSeal, 'emoji images receipt seal');
		assert.equal(value.scope, 'emoji-images-555');
		assert.equal(value.baseRevision, 'a3245b602e36a24c3f87b2944ccf5c70d8436cc9');
		assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
		assert.equal(value.upstreamFullServerMeasured, false);
		assert.equal(value.noInputDrift, true);
		assert.deepEqual(value.inputsAfter, value.inputs);
		assert.equal(Object.keys(value.inputs).length, 11);
		for (const [path, digest] of Object.entries(value.inputs)) {
			assert.equal(sha(rawRead(path)), digest, `Meta cache measured current input drift (emoji images): ${path}`);
		}
		const bytes = rawRead(directory + 'predecessor.json');
		assert.equal(sha(bytes), predecessorSeal, 'emoji images predecessor seal');
		const previous = JSON.parse(bytes);
		assert.equal(previous.baseRevision, value.baseRevision);
		assert.deepEqual(Object.keys(previous.files), emojiImagesPredecessorFiles);
		const result = {};
		for (const path of emojiImagesPredecessorFiles) {
			const binding = previous.files[path];
			if (path !== 'pnpm-lock.yaml') {
				assert.equal(binding.currentSha256, value.inputs[path]);
			}
			assert.equal(sha(rawRead(path)), binding.currentSha256, `Meta cache measured current input drift (emoji images): ${path}`);
			let before = rawRead(path).toString();
			for (const remove of binding.remove) {
				assert.equal(before.split(remove).length, 2, 'emoji images exact predecessor anchor');
				before = before.replace(remove, '');
			}
			assert.equal(sha(Buffer.from(before)), binding.previousSha256, 'emoji images exact predecessor identity');
			result[path] = before;
		}
		assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'source']);
		for (const run of value.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) {
				assert.equal(sha(log), run.logSha256, 'emoji images actual log drift');
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
export function readPreEmojiImages(path, rawRead = read, optional = optionalRead) {
	return withEvidenceRequestedPath(path, () => {
		if (!emojiImagesPredecessorFiles.includes(path)) {
			return readPreMetaInitialization(path, rawRead, optional);
		}
		// Ancestor validators must observe their requested live view as well as
		// the original source checked below, so their own cache detects drift.
		rawRead(path);
		// Keep successor metadata visible to ancestors even when this leaf is cached.
		readPreAvatarImages(path, rawRead, optional);
		registerEvidenceObserver(observerRegistration, rawRead, () => {
			const receipt = rawRead(directory + 'current-evidence.json');
			assert.equal(sha(receipt), receiptSeal, 'emoji images receipt seal');
			assert.equal(sha(rawRead(directory + 'predecessor.json')), predecessorSeal, 'emoji images predecessor seal');
			for (const input of Object.keys(JSON.parse(receipt).inputs)) {
				if (input.endsWith('.json')) {
					rawRead(input);
				}
			}
		});
		return Buffer.from(validateEmojiImagesEvidence(undefined, rawRead, optional)[path]);
	});
}
