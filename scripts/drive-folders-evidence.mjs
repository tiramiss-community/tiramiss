/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectIdCodecInput } from './id-codec-predecessor.mjs';
import assert from 'node:assert/strict';
import { scopedEvidenceValidation } from './evidence-validation-scope.mjs';
import { driveFilePredecessorFiles, readPreDriveFiles } from './drive-files-evidence.mjs';
import { createValidatedMetaPredecessorReader } from './meta-cache-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateDriveFolderPubsubSuccessor } from './drive-folder-pubsub-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/drive-folders/';
const evidencePath = directory + 'current-evidence.json';
const predecessorPath = directory + 'predecessor.json';
const seal = '25495f4f75b1b073844b395b067f74589f882e9595838ee26c01f28121caa953';
const predecessorSeal = '809dcee079c9c75fb8000e737405302925b852dc9028ee3f251ec42013abfc96';
const receiptPath = '/tmp/tiramiss-s1-round2-20261115/278/product-run-receipt.json';
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
 'packages/backend-next/test/unit/composition/http-app.test.ts',
]);
export function validateDriveFoldersSuccessor(value, rawRead = read, optional = optionalRead) {
 return scopedEvidenceValidation(validateDriveFoldersSuccessor, value, rawRead, optional, (rawRead, optional) => {
 const beforeMeta = createValidatedMetaPredecessorReader(rawRead, optional);
 const previousPubsub = validateDriveFolderPubsubSuccessor(undefined, rawRead, optional);
 const readFile = path => path in previousPubsub ? Buffer.from(previousPubsub[path]) : driveFilePredecessorFiles.includes(path) ? readPreDriveFiles(path, undefined, rawRead) : projectIdCodecInput(path, beforeMeta(path));
 if (value === undefined) {
  const bytes = readFile(evidencePath);
  assert.equal(sha(bytes), seal, 'folder current receipt seal');
  value = JSON.parse(bytes);
 }
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'folder current receipt seal');
 assert.equal(value.baseRevision, '86fce3926f97d2b62d790ff1e44449a57c2d33ee');
 assert.equal(value.runtimeRevision, 'c5b6b9574fbaf47340b766f9e11b69dc0b67c5c4');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(Object.keys(value.inputs).length, 20);
 for (const [path, digest] of Object.entries(value.inputs)) assert.equal(sha(readFile(path)), digest, `folder measured current input drift: ${path}`);
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'folder predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), successorFiles);
 for (const path of successorFiles) assert.notEqual(sha(Buffer.from(previous.files[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'near-unit', 'integration', 'source', 'sync', 'shipping', 'full-unit']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const actual = optional(run.log);
  if (actual !== null) {
   assert.equal(sha(actual), run.logSha256, 'folder actual log drift');
   if (run.passed !== undefined) {
    assert(actual.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(actual.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') assert(actual.toString().includes('drive-folders source: 57 cases --check'));
  }
 }
 const actual = optional(receiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'folder actual receipt drift');
 return previous.files;
 });
}
