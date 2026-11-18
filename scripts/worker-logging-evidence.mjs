/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectAnnouncementArchiveInput } from './announcement-archive-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const evidencePath = 'docs/superpowers/compatibility/worker-logging/runtime-evidence.json';
const seal = 'd8bc30f8ea3cf0c8e75bb57e1e57fe638764e3ca03907e1fc2af7396891a1c7a';
const predecessorPaths = [
	'packages/backend-next/src/composition/queue-workers.ts',
	'packages/backend-next/src/platform/job-queue/deliver.ts',
	'packages/backend-next/src/platform/job-queue/ended-poll-notification.ts',
	'packages/backend-next/src/platform/job-queue/runtime.ts',
	'packages/backend-next/src/platform/job-queue/user-webhook.ts',
	'packages/backend-next/src/platform/logger.ts',
	'packages/backend-next/test/unit/composition/queue-workers.test.ts',
	'packages/backend-next/test/unit/job-queue/deliver.test.ts',
	'packages/backend-next/test/unit/job-queue/runtime.test.ts',
	'packages/backend-next/test/unit/job-queue/user-webhook.test.ts',
	'packages/backend-next/test/unit/logger.test.ts',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const optionalRead = path => {
	try { return readFileSync(path); } catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
};
function record(readFile) {
	const bytes = readFile(evidencePath);
	assert.equal(sha(bytes), seal, 'worker logging evidence seal');
	return JSON.parse(bytes);
}

export function validateWorkerLoggingEvidence(readFile = read, optional = optionalRead) {
	const current = record(readFile);
	assert.equal(current.issueComplete, false, '#578 stays open');
	assert.equal(sha(readFile(current.previousEvidence.path)), current.previousEvidence.sha256, 'worker logging R1 archive identity');
	assert.equal(current.upstreamFullServerMeasured, false);
	assert.deepEqual(Object.keys(current.predecessors), predecessorPaths, 'worker logging finite predecessor scope');
	assert.equal(current.baseRevision, 'fe1a8106c3b3d5aba8ddf57de5e28e37e4e0e6ca');
	for (const [path, digest] of Object.entries(current.currentInputs)) {
		assert.equal(sha(projectAnnouncementArchiveInput(path, readFile(path))), digest, `worker logging measured input drift: ${path}`);
	}
	for (const [path, binding] of Object.entries(current.predecessors)) {
		assert.equal(binding.currentSha256, current.currentInputs[path], 'worker logging measured successor');
		assert.equal(sha(projectWorkerLoggingInput(path, readFile(path), readFile)), binding.previousSha256, 'worker logging predecessor identity');
	}
	for (const run of current.runs) {
		assert.equal(run.exitCode, 0, 'worker logging successful measurement');
		const bytes = optional(run.log);
		if (bytes !== null) {
			assert.equal(sha(bytes), run.logSha256, 'worker logging actual log drift');
		}
		if (run.artifact) {
			const artifact = optional(run.artifact);
			if (artifact !== null) {
				assert.equal(sha(artifact), run.artifactSha256, 'worker logging actual test artifact drift');
				const result = JSON.parse(artifact);
				assert.equal(result.numPassedTests, run.passed);
				assert.equal(result.numFailedTests, 0);
				assert.equal(result.numPendingTests, run.skipped);
				assert.equal(result.success, true);
			}
		}
	}
	return current;
}

// Keep the dated measurements on their original bytes. Only the exact measured
// worker-logging successor is projected; unknown bytes reach the existing guards.
export function projectWorkerLoggingInput(path, actual, readFile = read) {
	actual = projectAnnouncementArchiveInput(path, actual);
	if (!predecessorPaths.includes(path)) {
		return actual;
	}
	const binding = record(readFile).predecessors[path];
	if (!binding || sha(actual) !== binding.currentSha256) {
		return actual;
	}
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + inserted.length), inserted, 'worker logging predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'worker logging predecessor identity');
	return before;
}
