/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scopedEvidenceValidation, withEvidenceRequestedPath, getEvidenceCurrentReader, registerEvidenceObserver } from './evidence-validation-scope.mjs';
const directory = 'docs/superpowers/compatibility/notes-pagination/';
const receiptSeal = '7f0c730a8ef247ff244f5994150ece5c61671492734537b8805f134d86937aee';
const predecessorSeal = '3ecbc05f908b71d8e5750e70d8f3384fa7866ebaaeffda421d1bf3433c545e3a';
const historicalSeals = {"r1-current-evidence.json": "ffc91999009233ae9da8b05c589ca08854dc249f6e7d8647eff5acc1ea84312a", "r1-predecessor.json": "51074136dcd387e79ce49cb38079d7363a240caf03c50d6da237e6e6de838808"};
const observerRegistration = {};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const optionalRead = path => {
	try {
		return readFileSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
export const notesPaginationPredecessorFiles = Object.freeze([
	'packages/backend-next/src/composition/note-routes.ts',
	'packages/backend-next/src/modules/note/public.ts',
	'packages/backend-next/src/platform/database/note-reader.ts',
	'packages/backend-next/src/platform/database/note-authors.ts',
	'packages/backend-next/test/unit/composition/http-app.test.ts',
]);

export function validateNotesPaginationEvidence(value, rawRead = read, optional = optionalRead) {
	rawRead = getEvidenceCurrentReader(rawRead);
	return scopedEvidenceValidation(validateNotesPaginationEvidence, value, rawRead, optional, (rawRead, optional) => {
		for (const [name, digest] of Object.entries(historicalSeals)) assert.equal(sha(rawRead(directory + name)), digest, 'notes pagination historical receipt seal');
		const receipt = rawRead(directory + 'current-evidence.json');
		assert.equal(sha(receipt), receiptSeal, 'notes pagination receipt seal');
		value ??= JSON.parse(receipt);
		assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), receiptSeal, 'notes pagination receipt seal');
		assert.equal(value.scope, 'notes-pagination-305');
		assert.equal(value.baseRevision, '2fb256cd889200912cf68258e757f5e39429e495');
		assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
		assert.equal(value.measuredWorkingTree, true);
		assert.equal(value.noInputDrift, true);
		assert.equal(value.postingComplete, false);
		assert.equal(value.upstreamFullServerMeasured, false);
		assert.deepEqual(value.inputsAfter, value.inputs);
		assert.equal(Object.keys(value.inputs).length, 15);
		for (const [path, digest] of Object.entries(value.inputs)) {
			assert.equal(sha(rawRead(path)), digest, `measured current input drift (notes pagination): ${path}`);
		}
		const bytes = rawRead(directory + 'predecessor.json');
		assert.equal(sha(bytes), predecessorSeal, 'notes pagination predecessor seal');
		const previous = JSON.parse(bytes);
		assert.equal(previous.baseRevision, value.baseRevision);
		assert.deepEqual(Object.keys(previous.files), notesPaginationPredecessorFiles);
		const result = {};
		for (const [path, binding] of Object.entries(previous.files)) {
			assert.equal(binding.currentSha256, value.inputs[path]);
			let before = Buffer.from(rawRead(path));
			assert.equal(sha(before), binding.currentSha256, `measured current input drift (notes pagination): ${path}`);
			for (const patch of [...binding.patches].reverse()) {
				const insert = Buffer.from(patch.insert);
				assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert, 'notes pagination exact predecessor anchor');
				before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
			}
			assert.equal(sha(before), binding.previousSha256, 'notes pagination exact predecessor identity');
			result[path] = before.toString();
		}
		assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source']);
		for (const run of value.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) {
				assert.equal(sha(log), run.logSha256, 'notes pagination actual log drift');
				if (run.passed !== undefined) assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`), 'notes pagination actual test count');
			}
		}
		return result;
	});
}

export function readBeforeNotesPagination(path, rawRead = read, optional = optionalRead) {
	return withEvidenceRequestedPath(path, () => {
		if (!notesPaginationPredecessorFiles.includes(path)) return rawRead(path);
		rawRead(path);
		registerEvidenceObserver(observerRegistration, rawRead, () => {
			for (const name of ['current-evidence.json', 'predecessor.json', ...Object.keys(historicalSeals)]) rawRead(directory + name);
		});
		return Buffer.from(validateNotesPaginationEvidence(undefined, rawRead, optional)[path]);
	});
}
