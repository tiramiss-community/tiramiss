/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readPrePublicEmojis } from './public-emojis-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';

const directory = 'docs/superpowers/compatibility/public-documents/';
const receiptSeal = 'e1ccf2067ceb77de4b902437536123b00e913d3481f1b66c4ca407a3ee3288b3';
const predecessorSeal = '7cbc540a7bf7f2d257775b26deb0121d52257c1ae3eca5e2ec4701632ac4b5e3';
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
export const publicDocumentsPredecessorFiles = Object.freeze([
	'packages/backend-next/src/composition/http-app.ts',
	'packages/backend-next/test/unit/composition/http-app.test.ts',
]);

export function validatePublicDocumentsEvidence(value, rawRead = read, optional = optionalRead) {
	return scopedEvidenceValidation(validatePublicDocumentsEvidence, value, rawRead, optional, (rawRead, optional) => {
		const currentRead = rawRead;
		rawRead = path => readPrePublicEmojis(path, currentRead, optional);
		const receipt = rawRead(directory + 'current-evidence.json');
		assert.equal(sha(receipt), receiptSeal, 'public documents receipt seal');
		if (value === undefined) {
			value = JSON.parse(receipt);
		}
		assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), receiptSeal, 'public documents receipt seal');
		assert.equal(value.scope, 'public-documents-552');
		assert.equal(value.baseRevision, '0927918fe987cae2fcbf2b69bdb58ee6c5ca734a');
		assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
		assert.equal(value.measuredWorkingTree, true);
		assert.equal(value.upstreamFullServerMeasured, false);
		assert.equal(value.inputCapture, 'at-final-freeze');
		assert.equal(Object.keys(value.inputs).length, 10);
		for (const [path, digest] of Object.entries(value.inputs)) {
			assert.equal(sha(rawRead(path)), digest, `Meta cache measured current input drift (public documents): ${path}`);
		}
		const bytes = rawRead(directory + 'predecessor.json');
		assert.equal(sha(bytes), predecessorSeal, 'public documents predecessor seal');
		const previous = JSON.parse(bytes);
		assert.equal(previous.baseRevision, value.baseRevision);
		assert.deepEqual(Object.keys(previous.files), publicDocumentsPredecessorFiles);
		const result = {};
		for (const path of publicDocumentsPredecessorFiles) {
			const binding = previous.files[path];
			assert.equal(binding.currentSha256, value.inputs[path]);
			assert.equal(sha(Buffer.from(binding.previous)), binding.previousSha256, 'public documents exact predecessor identity');
			assert.notEqual(binding.currentSha256, binding.previousSha256);
			result[path] = binding.previous;
		}
		assert.deepEqual(value.runs.map(run => run.name), ['sync', 'build', 'typecheck', 'unit', 'integration', 'source']);
		for (const run of value.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) {
				assert.equal(sha(log), run.logSha256, 'public documents actual log drift');
				if (run.passed !== undefined) {
					assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
				}
				if (run.name === 'source') {
					assert(log.toString().includes('17 cases / 51 real HTTP requests --check PASS'));
				}
			}
		}
		return result;
	});
}

// Only two shared composition inputs enter this view. Unrelated feature bytes
// pass through, and every public invocation checks current product inputs first.
export function readPrePublicDocuments(path, rawRead = read, optional = optionalRead) {
	return withEvidenceRequestedPath(path, () => publicDocumentsPredecessorFiles.includes(path)
		? Buffer.from(validatePublicDocumentsEvidence(undefined, rawRead, optional)[path])
		: rawRead(path));
}
