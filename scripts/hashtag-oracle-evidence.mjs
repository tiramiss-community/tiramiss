/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/note/hashtag/';
const evidencePath = directory + 'oracle-schedule-evidence.json';
const predecessorPath = directory + 'oracle-schedule-predecessor.json';
const seal = '3bee3369e258f3d5e93a539aa1839cfa0427b7febc35e92e2024eeaae3e573a3';
const predecessorSeal = '01e30645d2280e6c4ed95d0b211c06f891e8eef14bb611d1ae17e3379fc5cef5';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const successorFiles = Object.freeze(['packages/backend-next/test/integration/note-hashtags.test.ts']);
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'hashtag oracle receipt seal');
 return JSON.parse(bytes);
}

export function validateHashtagOracleSuccessor(value = record(read), readFile = read, optional = optionalRead) {
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'hashtag oracle receipt seal');
 assert.equal(value.baseRevision, 'bb735037096259712fd381d910423ffc9927e0e1');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(value.failedCi.runId, 43630590850);
 assert.equal(Object.keys(value.inputs).length, 4);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 for (const [path, digest] of Object.entries(value.inputs)) assert.equal(sha(readFile(path)), digest, `hashtag oracle measured input drift: ${path}`);
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'hashtag oracle predecessor seal');
 const saved = JSON.parse(bytes);
 assert.equal(saved.commit, value.baseRevision);
 assert.deepEqual(Object.keys(saved.files), successorFiles);
 for (const path of successorFiles) assert.notEqual(sha(Buffer.from(saved.files[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['hashtags-integration', 'typecheck']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'hashtag oracle actual log drift');
   if (run.passed !== undefined) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
  }
 }
 const receipt = optional('/tmp/tiramiss-s1-325-ci-20261115/verification.json');
 if (receipt !== null) assert.equal(sha(receipt), seal, 'hashtag oracle actual receipt drift');
 return saved.files;
}

export function readPreHashtagOracle(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = successorFiles.includes(path) ? Buffer.from(validateHashtagOracleSuccessor(record(readFile), readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
