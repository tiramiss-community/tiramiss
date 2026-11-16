/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';

const directory = 'docs/superpowers/compatibility/public-emojis/';
const receiptSeal = 'e04930f90ff0be13f933d9c1133f6d9f131980c4c6285329b189d2060ac046c6';
const predecessorSeal = '907bbd2df53c0567f5fd1469616ac9838d63ab1b73d7fc48a4ffc076b0dd8936';
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
export const publicEmojisPredecessorFiles = Object.freeze([
	'packages/backend-next/src/composition/http-app.ts',
	'packages/backend-next/src/http/api-endpoint.ts',
	'packages/backend-next/src/http/api-request.ts',
	'packages/backend-next/test/unit/composition/http-app.test.ts',
]);

export function validatePublicEmojisEvidence(value, rawRead = read, optional = optionalRead) {
	return scopedEvidenceValidation(validatePublicEmojisEvidence, value, rawRead, optional, (rawRead, optional) => {
		const bytes = rawRead(directory + 'current-evidence.json');
		assert.equal(sha(bytes), receiptSeal, 'public emojis receipt seal');
		value ??= JSON.parse(bytes);
		assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), receiptSeal, 'public emojis receipt seal');
		assert.equal(value.scope, 'public-emojis-304');
		assert.equal(value.baseRevision, '8c3f6d51e17a2a2f73c2f2156a384c2519ca21c5');
		assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
		assert.equal(value.measuredWorkingTree, true);
		assert.equal(value.upstreamFullServerMeasured, false);
		assert.equal(value.noInputDrift, true);
		assert.equal(Object.keys(value.inputs).length, 13);
		assert.deepEqual(value.inputsAfter, value.inputs);
		for (const [path, digest] of Object.entries(value.inputs)) {
			assert(!/package\.json$|pnpm-lock|backend-inventory/.test(path));
			assert.equal(sha(rawRead(path)), digest, `Meta cache measured current input drift (public emojis): ${path}`);
		}
		const predecessorBytes = rawRead(directory + 'predecessor.json');
		assert.equal(sha(predecessorBytes), predecessorSeal, 'public emojis predecessor seal');
		const previous = JSON.parse(predecessorBytes);
		assert.equal(previous.baseRevision, value.baseRevision);
		assert.deepEqual(Object.keys(previous.files), publicEmojisPredecessorFiles);
		const result = {};
		for (const [path, binding] of Object.entries(previous.files)) {
			assert.equal(binding.currentSha256, value.inputs[path]);
			let current = rawRead(path).toString();
			assert.equal(sha(Buffer.from(current)), binding.currentSha256, `Meta cache measured current input drift (public emojis): ${path}`);
			for (const patch of [...binding.patches].reverse()) {
				assert.equal(current.slice(patch.offset, patch.offset + patch.before.length), patch.before, 'public emojis exact predecessor patch');
				current = current.slice(0, patch.offset) + patch.after + current.slice(patch.offset + patch.before.length);
			}
			assert.equal(sha(Buffer.from(current)), binding.previousSha256, 'public emojis exact predecessor identity');
			result[path] = current;
		}
		assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source']);
		for (const run of value.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) {
				assert.equal(sha(log), run.logSha256, 'public emojis actual log drift');
				if (run.passed !== undefined) {
					assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
				}
				if (run.name === 'source') {
					assert(log.toString().includes('16 pinned public emoji HTTP/PostgreSQL observations / 2 prefetch observations'));
				}
			}
		}
		return result;
	});
}

// Four changed shared files project to the exact base image. Current product
// inputs and available logs are checked before any historical bytes are returned.
export function readPrePublicEmojis(path, rawRead = read, optional = optionalRead) {
	return withEvidenceRequestedPath(path, () => publicEmojisPredecessorFiles.includes(path)
		? Buffer.from(validatePublicEmojisEvidence(undefined, rawRead, optional)[path])
		: rawRead(path));
}
