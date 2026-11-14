/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-outbox-current-evidence.json';
const predecessorPath = directory + 'local-outbox-predecessor.json';
const receiptPath = '/tmp/tiramiss-s1-324-20261114/product-run-receipt.json';
const seal = '0a9950799066aede10f18270a9df1ec594e3f4afafd1ac976395bc6db6580c38';
const canonicalSeal = '417553bd5a3f912e43c581c87f2148379b5a437756188450e6c6c4048d8c7767';
const predecessorSeal = '9d1de5de64954a6d0d27882a9d0daeb6ddc90ced248f5d928f6575c823144171';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const successorFiles = Object.freeze([
 'packages/backend-next/src/composition/http-app.ts',
 'packages/backend-next/src/modules/federation/note-activity.ts',
 'packages/backend-next/src/modules/federation/public.ts',
 'packages/backend-next/src/platform/database/local-featured.ts',
 'packages/backend-next/test/unit/composition/http-app.test.ts',
 'packages/backend-next/test/unit/federation/note-activity.test.ts',
]);
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'outbox current receipt seal');
 return JSON.parse(bytes);
}
function predecessor(value, readFile) {
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'outbox predecessor seal');
 const saved = JSON.parse(bytes);
 assert.equal(saved.commit, value.baseRevision);
 assert.deepEqual(Object.keys(saved.files), successorFiles, 'outbox exact six predecessors');
 return saved.files;
}

// This is the terminal finite hop: no Git, subprocess, ancestor imports or
// recursive manifests. The unchanged host receipt is the current measurement.
export function validateOutboxSuccessor(value = record(read), readFile = read, optional = optionalRead) {
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), canonicalSeal, 'outbox current receipt seal');
 assert.equal(value.runtimeRevision, '1e75c5b2b3be158fba8afb14a9c1c30809825127');
 assert.equal(value.baseRevision, '5981cce83b9243bf22102b2f0ba1b866b1ed03da');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(Object.keys(value.inputs).length, 22, 'outbox finite current inputs');
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs, 'outbox measurement input drift');
 for (const [path, digest] of Object.entries(value.inputs)) {
  assert.equal(sha(readFile(path)), digest, `outbox measured current input drift: ${path}`);
 }
 const previous = predecessor(value, readFile);
 for (const path of successorFiles) assert.notEqual(sha(Buffer.from(previous[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source', 'source-contract'], 'outbox required suites');
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0, 'outbox successful measurement');
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'outbox actual log drift');
   const log = bytes.toString();
   if (run.name === 'unit' || run.name === 'integration') {
    assert(log.includes(`Tests  ${run.passed} passed (${run.passed})`), 'outbox actual test count');
    assert(log.includes(`Test Files  ${run.files} passed (${run.files})`), 'outbox actual file count');
   }
   if (run.name === 'source') assert(log.includes('115 cases --check PASS'), 'outbox actual source count');
   if (run.name === 'source-contract') for (const line of ['tests 12', 'pass 12', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0']) assert(log.includes(line), 'outbox actual contract count');
  }
 }
 const receipt = optional(receiptPath);
 if (receipt !== null) assert.equal(sha(receipt), seal, 'outbox actual receipt drift');
 return previous;
}

// Outside the six historical consumers bytes pass through untouched. Before
// any projection, check all 22 measured inputs, both seals and available logs.
export function readPreOutbox(path, encoding, readFile = read, optional = optionalRead) {
 let bytes;
 if (successorFiles.includes(path)) {
  const value = record(readFile);
  bytes = Buffer.from(validateOutboxSuccessor(value, readFile, optional)[path]);
 } else bytes = readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
