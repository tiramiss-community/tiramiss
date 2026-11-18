/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const recordPath = 'docs/superpowers/compatibility/worker-logging/integration-followup.json';
const seal = '0dfcb866dfd9b2a982b20dcc8ac11cb92fd6a55f98c79f045688bed97d2416d6';
const fixturePath = 'packages/backend-next/test/integration/deliver-queue.test.ts';
const processFixturePath = 'packages/backend-next/test/processes/note-delete-integration.test.ts';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
	try { return readFileSync(path); } catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
};
function record(readFile) {
	const bytes = readFile(recordPath);
	assert.equal(sha(bytes), seal, 'worker logging integration follow-up seal');
	return JSON.parse(bytes);
}

export function projectWorkerLoggingIntegrationInput(path, actual, readFile = read) {
	if (path !== fixturePath && path !== processFixturePath) {
		return actual;
	}
	const binding = record(readFile).files[path];
	if (sha(actual) !== binding.sha256) {
		return actual;
	}
	let previous = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(previous.subarray(patch.offset, patch.offset + inserted.length), inserted, 'worker logging integration predecessor anchor');
		previous = Buffer.concat([previous.subarray(0, patch.offset), Buffer.from(patch.previous), previous.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(previous), binding.previousSha256, 'worker logging integration predecessor identity');
	return previous;
}

export function validateWorkerLoggingIntegrationFollowup(readFile = read, optional = optionalRead) {
	const current = record(readFile);
	assert.equal(current.baseRevision, '0fd9068da5cfde3f9a6a027e2959aa39db7f3bb4');
	assert.equal(current.issueComplete, false);
	assert.deepEqual(Object.keys(current.files), [fixturePath, processFixturePath]);
	assert.equal(sha(readFile(current.r2.path)), current.r2.sha256, 'worker logging frozen R2 evidence drift');
	for (const [path, binding] of Object.entries(current.files)) {
		assert.equal(sha(readFile(path)), binding.sha256, `worker logging measured integration input drift: ${path}`);
	}
	for (const path of [fixturePath, processFixturePath]) {
		assert.equal(sha(projectWorkerLoggingIntegrationInput(path, readFile(path), readFile)), current.files[path].previousSha256);
	}
	const failedLog = optional(current.observedContractFailure.log);
	if (failedLog !== null) {
		assert.equal(sha(failedLog), current.observedContractFailure.logSha256, 'worker logging integration actual artifact drift');
	}
	for (const run of current.runs) {
		assert.equal(run.exitCode, 0);
		for (const [path, digest] of [[run.log, run.logSha256], ...(run.artifact ? [[run.artifact, run.artifactSha256]] : [])]) {
			const bytes = optional(path);
			if (bytes !== null) {
				assert.equal(sha(bytes), digest, 'worker logging integration actual artifact drift');
			}
		}
		if (run.artifact && optional(run.artifact) !== null) {
			const result = JSON.parse(optional(run.artifact));
			assert.equal(result.success, true);
			assert.equal(result.numPassedTests, run.passed);
			assert.equal(result.numFailedTests, 0);
			assert.equal(result.numPendingTests, run.skipped);
		}
	}
	return current;
}
