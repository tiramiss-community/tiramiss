/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/drive-folders/';
const evidencePath = directory + 'observation-sync-evidence.json';
const predecessorPath = directory + 'observation-sync-predecessor.json';
const actualReceiptPath = '/tmp/tiramiss-s1-round2-20261115/278/observation-sync/fixture-run-receipt.json';
const seal = '561296523773f1f19bdb347a31db22806759772635ec6619e7f36d736f7d0558';
const predecessorSeal = '56508d32d78f8da7ccb7f7dbbcc90779baecdaf4eb809e6f3051884b51e2884a';
export const folderObservationPath = 'packages/backend-next/test/integration/drive-folders.test.ts';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export function validateFolderObservation(value, readFile = read, optional = optionalRead) {
 if (value === undefined) {
  const bytes = readFile(evidencePath);
  assert.equal(sha(bytes), seal, 'folder observation receipt seal');
  value = JSON.parse(bytes);
 }
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'folder observation receipt seal');
 assert.equal(value.fixtureRevision, '2dc6d817e2122d48f5aa25c82f02104bfaab1d92');
 assert.equal(value.baseRevision, '12447720b784d4470ef567087e0b5b137cbc010d');
 assert.deepEqual(Object.keys(value.inputs), [folderObservationPath]);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(sha(readFile(folderObservationPath)), value.inputs[folderObservationPath], 'folder measured current input drift (observation fixture)');
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'folder observation predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), [folderObservationPath]);
 assert.equal(sha(Buffer.from(previous.files[folderObservationPath])), 'a12b2d79a2e0e0093a1870d4237f36777e58958f0b1de6bf65c20a33f32e81c4');
 assert.notEqual(sha(Buffer.from(previous.files[folderObservationPath])), value.inputs[folderObservationPath]);
 assert.equal(value.run.exitCode, 0);
 assert.equal(value.run.passed, 69);
 assert.equal(value.run.files, 1);
 const log = optional(value.run.log);
 if (log !== null) {
  assert.equal(sha(log), value.run.logSha256, 'folder observation actual log drift');
  assert(log.toString().includes('Tests  69 passed (69)'));
  assert(log.toString().includes('Test Files  1 passed (1)'));
 }
 const actual = optional(actualReceiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'folder observation actual receipt drift');
 assert.equal(value.controlledCounterexample.exitCode, 1);
 const probe = optional(value.controlledCounterexample.log);
 if (probe !== null) assert.equal(sha(probe), value.controlledCounterexample.logSha256, 'folder observation actual counterexample drift');
 return { ...previous.files };
}
export function readPreFolderObservation(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = path === folderObservationPath ? Buffer.from(validateFolderObservation(undefined, readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
