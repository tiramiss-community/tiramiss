/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'instance-admin-current-evidence.json';
const predecessorPath = directory + 'instance-admin-predecessor.json';
const receiptPath = '/tmp/tiramiss-s1-362-20261114/product-run-receipt.json';
const seal = 'b0b02238de2145db5b554af74c1319a6c168abec80595e18638d4099f4da5aaa';
const predecessorSeal = '7180d4fbc049f421b4a6479af42c20c3a829da1c2f0c8e30999a17f5473d9769';
const read = path => readFileSync(new URL(path, root));
const sha = value => createHash('sha256').update(value).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const successorFiles = Object.freeze([
 "packages/backend-next/src/composition/http-app.ts",
 "packages/backend-next/src/modules/audit/public.ts",
 "packages/backend-next/src/modules/federation/deliver-job.ts",
 "packages/backend-next/src/modules/federation/instance.ts",
 "packages/backend-next/src/modules/federation/public.ts",
 "packages/backend-next/src/platform/connect-resources.ts",
 "packages/backend-next/src/platform/instance-ledger.ts",
 "packages/backend-next/test/unit/composition/http-app.test.ts",
 "packages/backend-next/test/unit/federation/local-featured-red.test.ts"
]);
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'instance admin current receipt seal');
 return JSON.parse(bytes);
}

// The terminal hop validates the actual merged runtime measurement and restores
// only nine predecessor files. No Git, subprocess or ancestor reader is needed.
export function validateInstanceAdminSuccessor(value = record(read), readFile = read, optional = optionalRead) {
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'instance admin current receipt seal');
 assert.equal(value.runtimeRevision, '82d47cc0bb6dd61a15b33ca0166157527a505683');
 assert.equal(value.baseRevision, 'bb735037096259712fd381d910423ffc9927e0e1');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(Object.keys(value.inputs).length, 16);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 for (const [path, digest] of Object.entries(value.inputs)) {
  assert.equal(sha(readFile(path)), digest, `instance admin measured current input drift: ${path}`);
 }
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'instance admin predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), successorFiles);
 for (const path of successorFiles) assert.notEqual(sha(Buffer.from(previous.files[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source', 'sync']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'instance admin actual log drift');
   if (run.name === 'unit' || run.name === 'integration') {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') assert(bytes.toString().includes('59 cases --check PASS'));
  }
 }
 const actual = optional(receiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'instance admin actual receipt drift');
 return previous.files;
}

export function readPreInstanceAdmin(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = successorFiles.includes(path) ? Buffer.from(validateInstanceAdminSuccessor(record(readFile), readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
