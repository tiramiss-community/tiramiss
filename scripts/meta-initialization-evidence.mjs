/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getEvidenceCurrentReader, registerEvidenceObserver, scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';

export const metaInitializationLifecyclePath = 'packages/backend-next/src/processes/lifecycle.ts';
const directory = 'docs/superpowers/compatibility/meta-initialization/';
const previousSeal = '0641520662e895603b39dad557c97978c24c19aa081bec9b182924a544a76f99';
const inputsSeal = '82f78900c034a9158c70affeb18e4cd6edb7349e72085adfa01d92c63b0356fb';
const observer = {};
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
	try { return readFileSync(path); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};

export function validateMetaInitializationEvidence(rawRead = read, optional = optionalRead) {
	rawRead = getEvidenceCurrentReader(rawRead);
	return scopedEvidenceValidation(validateMetaInitializationEvidence, undefined, rawRead, optional, (rawRead, optional) => {
		const inputsBytes = rawRead(directory + 'r2-inputs.json');
		assert.equal(sha(inputsBytes), inputsSeal, 'Meta startup measured input binding seal');
		const binding = JSON.parse(inputsBytes);
		assert.equal(binding.issue, 574);
		const proof = JSON.parse(rawRead(directory + 'evidence.json'));
		assert.equal(proof.round, 'R2');
		assert.equal(proof.runtimeChanged, true);
		assert.equal(proof.normalEntrypointEagerMetaProven, true);
		assert.equal(proof.noInputDrift, true);
		for (const [path, digest] of Object.entries(binding.inputs)) {
			assert.equal(proof.inputs[path], digest, 'Meta startup measured binding');
			assert.equal(sha(rawRead(path)), digest, `Meta startup measured current input drift: ${path}`);
		}
		for (const run of proof.runs) {
			assert.equal(run.exitCode, 0);
			const log = optional(run.log);
			if (log !== null) assert.equal(sha(log), run.logSha256, 'Meta startup actual log drift');
		}
		const previousBytes = rawRead(directory + 'lifecycle-predecessor.json');
		assert.equal(sha(previousBytes), previousSeal, 'Meta startup lifecycle predecessor seal');
		const previous = JSON.parse(previousBytes);
		assert.equal(previous.baseRevision, '4e7cda80560da3c9c46f5b02b29c5f6459e2b785');
		assert.deepEqual(Object.keys(previous.files), [metaInitializationLifecyclePath]);
		return previous.files[metaInitializationLifecyclePath];
	});
}

// Only the changed lifecycle path invokes this gate. Other requests remain live reads.
export function readPreMetaInitialization(path, rawRead = read, optional = optionalRead) {
	return withEvidenceRequestedPath(path, () => {
		if (path !== metaInitializationLifecyclePath) return rawRead(path);
		rawRead(path);
		registerEvidenceObserver(observer, rawRead, () => {
			for (const file of ['r2-inputs.json', 'lifecycle-predecessor.json', 'evidence.json']) rawRead(directory + file);
		});
		return Buffer.from(validateMetaInitializationEvidence(rawRead, optional));
	});
}
