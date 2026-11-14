/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/url-preview/';
const evidencePath = directory + 'fixture-correction-evidence.json';
const predecessorPath = directory + 'fixture-correction-predecessor.json';
const receiptPath = '/tmp/tiramiss-s1-377-20261115/fixture-correction-receipt.json';
const seal = '183baee90cbb86c2c822448ca05682758737a504285d81bb6e79a8072a17d0ff';
const predecessorSeal = '46fda05d6becd463ddb816d74b1df50e3259496c34553ecfe0fe7e55277bb2a7';
const read = path => readFileSync(new URL(path, root));
const sha = value => createHash('sha256').update(value).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const fixturePath = 'packages/backend-next/test/unit/remote-emoji-resources.test.ts';
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'preview mock correction receipt seal');
 return JSON.parse(bytes);
}
export function validatePreviewFixture(value, readFile = read, optional = optionalRead) {
 if (value === undefined) value = record(readFile);
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'preview mock correction receipt seal');
 assert.equal(value.baseRevision, 'e972af7583aef146d7c77a6692b6387b896dff48');
 assert.equal(value.measuredWorkingTree, true);
 assert.equal(value.failedCi.runId, 43650059099);
 assert.equal(value.failedCi.jobId, 132616298876);
 assert.deepEqual(Object.keys(value.inputs), [fixturePath]);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(sha(readFile(fixturePath)), value.inputs[fixturePath], 'preview mock correction measured input drift');
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'preview mock correction predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), [fixturePath]);
 assert.equal(sha(Buffer.from(previous.files[fixturePath])), '0e91899d797f7a9e94930966ce4e909f24d6054872ffbfe5ecd176146efd5f78');
 assert.notEqual(sha(Buffer.from(previous.files[fixturePath])), value.inputs[fixturePath]);
 assert.deepEqual(value.runs.map(run => run.name), ['focused', 'full-unit', 'shipping']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'preview mock correction actual log drift');
   if (run.passed !== undefined) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
  }
 }
 const receipt = optional(receiptPath);
 if (receipt !== null) assert.equal(sha(receipt), seal, 'preview mock correction actual receipt drift');
 return previous.files;
}
export function readPrePreviewFixture(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = path === fixturePath ? Buffer.from(validatePreviewFixture(record(readFile), readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
