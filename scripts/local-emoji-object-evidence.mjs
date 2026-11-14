/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readPreHashtagOracle } from './hashtag-oracle-evidence.mjs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-emoji-object-current-evidence.json';
const predecessorPath = directory + 'local-emoji-object-predecessor.json';
const seal = '96742cb8b65b0583c0edf5557bc8b3f293774e2df10e2f9793292a6cbfcec55d';
const predecessorSeal = 'beb9b499aad2fd96da4a6a8f04e06f760aba7aa1db441420bef35433172bf848';
const runtime = '140acaf7d0283a76cc4de4a9f0227ae130a86ccd';
const read = path => readFileSync(new URL(path, root));
const sha = value => createHash('sha256').update(value).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const successorFiles = Object.freeze([
 'packages/backend-next/src/composition/http-app.ts',
 'packages/backend-next/test/unit/composition/http-app.test.ts',
]);
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'emoji current receipt seal');
 return JSON.parse(bytes);
}

// The terminal hashtag oracle reader restores the one changed integration test
// before historical consumers inspect it; this Emoji receipt and its inputs stay fixed.
export function validateEmojiObjectSuccessor(value = record(read), rawRead = read, optional = optionalRead) {
 const readFile = path => readPreHashtagOracle(path, undefined, rawRead, optional);
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'emoji current receipt seal');
 assert.equal(value.runtimeRevision, runtime);
 assert.equal(value.baseRevision, '0ffa36d8f5ba78d97acd45a8b74ebf544e9e3408');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(Object.keys(value.inputs).length, 14);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 for (const [path, digest] of Object.entries(value.inputs)) {
  assert.equal(sha(readFile(path)), digest, `emoji measured current input drift: ${path}`);
 }
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'emoji predecessor seal');
 const saved = JSON.parse(bytes);
 assert.equal(saved.commit, value.baseRevision);
 assert.deepEqual(Object.keys(saved.files), successorFiles);
 for (const path of successorFiles) assert.notEqual(sha(Buffer.from(saved.files[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['sync', 'build', 'typecheck', 'unit', 'integration', 'source', 'source-contract']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'emoji actual log drift');
   if (run.name === 'unit' || run.name === 'integration') {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') assert(bytes.toString().includes('53 cases --check PASS'));
   if (run.name === 'source-contract') for (const line of ['tests 6', 'pass 6', 'fail 0', 'skipped 0']) assert(bytes.toString().includes(line));
  }
 }
 const receipt = optional('/tmp/tiramiss-s1-325-20261114/product-run-receipt.json');
 if (receipt !== null) assert.equal(sha(receipt), seal, 'emoji actual receipt drift');
 return saved.files;
}

export function readPreEmojiObject(path, encoding, rawRead = read, optional = optionalRead) {
 const readFile = path => readPreHashtagOracle(path, undefined, rawRead, optional);
 const bytes = successorFiles.includes(path) ? Buffer.from(validateEmojiObjectSuccessor(record(readFile), rawRead, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
