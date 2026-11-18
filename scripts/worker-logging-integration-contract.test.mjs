/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectWorkerLoggingIntegrationInput, validateWorkerLoggingIntegrationFollowup } from './worker-logging-integration-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const offline = () => null;

test('integration log assertions have separate actual measurements while R2 bytes remain frozen', () => {
	const value = validateWorkerLoggingIntegrationFollowup(read, offline);
	assert.deepEqual(value.runs.filter(run => run.artifact).map(run => [run.name, run.passed]), [['integration', 11], ['process', 1]]);
	const path = Object.keys(value.files)[0];
	assert.equal(sha(projectWorkerLoggingIntegrationInput(path, read(path))), value.files[path].previousSha256);
	const drift = Buffer.concat([read(path), Buffer.from('\n')]);
	assert.equal(projectWorkerLoggingIntegrationInput(path, drift), drift);
	const unrelated = Buffer.from('untouched');
	assert.equal(projectWorkerLoggingIntegrationInput('unrelated', unrelated), unrelated);
});

test('integration current bytes, frozen R2 record, follow-up and actual logs reject corruption', () => {
	const value = validateWorkerLoggingIntegrationFollowup(read, offline);
	for (const path of Object.keys(value.files)) {
		assert.throws(() => validateWorkerLoggingIntegrationFollowup(file => file === path ? Buffer.from('forged') : read(file), offline), /measured integration input drift/);
	}
	assert.throws(() => validateWorkerLoggingIntegrationFollowup(path => path === value.r2.path ? Buffer.from('{}') : read(path), offline), /frozen R2 evidence drift/);
	assert.throws(() => validateWorkerLoggingIntegrationFollowup(path => path.endsWith('integration-followup.json') ? Buffer.from('{}') : read(path), offline), /follow-up seal/);
	assert.throws(() => validateWorkerLoggingIntegrationFollowup(read, path => path === value.observedContractFailure.log ? Buffer.from('forged') : null), /actual artifact drift/);
	for (const run of value.runs) {
		assert.throws(() => validateWorkerLoggingIntegrationFollowup(read, path => path === run.log ? Buffer.from('forged') : null), /actual artifact drift/);
	}
	validateWorkerLoggingIntegrationFollowup();
});
