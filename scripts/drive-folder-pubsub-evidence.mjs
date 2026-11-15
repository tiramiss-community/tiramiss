/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { driveFilePredecessorFiles, readPreDriveFiles } from './drive-files-evidence.mjs';
import { createValidatedMetaPredecessorReader } from './meta-cache-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateFolderObservation } from './drive-folder-observation-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/drive-folders/';
const evidencePath = directory + 'pubsub-fix-evidence.json';
const predecessorPath = directory + 'pubsub-fix-predecessor.json';
const seal = '82403ca1f6ea5a54eb1a31cca8736dcf03fecd62c89ea614180abdf3a5d85c3d';
const predecessorSeal = '9d48ea0c83a23561d38db81f26a9870450bfd46af4db35bb948d03dcf0ef214c';
const initialSeal = '25495f4f75b1b073844b395b067f74589f882e9595838ee26c01f28121caa953';
const receiptPath = '/tmp/tiramiss-s1-round2-20261115/278/pubsub-product-run-receipt.json';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const pubsubSuccessorFiles = Object.freeze([
 '.github/workflows/test-backend-next.yml',
 'packages/backend-next/compose.test.yml',
 'packages/backend-next/src/composition/drive-folders-http.ts',
 'packages/backend-next/src/platform/drive-folder-publisher.ts',
 'packages/backend-next/src/platform/posting-stream.ts',
 'packages/backend-next/test/integration/drive-folders.test.ts',
 'packages/backend-next/test/unit/drive/folder-drain.test.ts',
]);
export function validateDriveFolderPubsubSuccessor(value, rawRead = read, optional = optionalRead) {
 const beforeMeta = createValidatedMetaPredecessorReader(rawRead, optional);
 const previousObservation = validateFolderObservation(undefined, rawRead, optional);
 const readFile = path => Object.hasOwn(previousObservation, path) ? Buffer.from(previousObservation[path]) : driveFilePredecessorFiles.includes(path) ? readPreDriveFiles(path, undefined, rawRead) : beforeMeta(path);
 if (value === undefined) {
  const bytes = readFile(evidencePath);
  assert.equal(sha(bytes), seal, 'folder pubsub current receipt seal');
  value = JSON.parse(bytes);
 }
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'folder pubsub current receipt seal');
 assert.equal(value.baseRevision, 'c1f09e2a093bd2182e489386da53e99e2b7a69c0');
 assert.equal(value.runtimeRevision, 'bf0ef2115eb202250713800c61c26e5af32f4952');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(Object.keys(value.inputs).length, 24);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 for (const [path, digest] of Object.entries(value.inputs)) assert.equal(sha(readFile(path)), digest, `folder measured current input drift (pubsub successor): ${path}`);
 assert.equal(sha(readFile(directory + 'current-evidence.json')), initialSeal, 'folder initial published receipt seal');
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'folder pubsub predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), pubsubSuccessorFiles);
 for (const path of pubsubSuccessorFiles) assert.notEqual(sha(Buffer.from(previous.files[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'near-unit', 'integration', 'process', 'source', 'sync', 'shipping', 'full-unit']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'folder pubsub actual log drift');
   if (run.passed !== undefined) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') assert(bytes.toString().includes('drive-folders source: 57 cases --check'));
  }
 }
 const actual = optional(receiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'folder pubsub actual receipt drift');
 return previous.files;
}
export function readPreDriveFolderPubsub(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = pubsubSuccessorFiles.includes(path) ? Buffer.from(validateDriveFolderPubsubSuccessor(undefined, readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
