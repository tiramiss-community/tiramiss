/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectAnnouncementArchiveInput } from './announcement-archive-predecessor.mjs';
import assert from 'node:assert/strict';
import { scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';
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
const workflowPath = '.github/workflows/test-backend-next.yml';
const videoFfmpegStep = '      - name: Install FFmpeg\n        run: |\n          sudo apt update\n          sudo apt install -y ffmpeg\n';
const processRedisService = '      redis-pubsub:\n        image: redis:8\n        ports: [\'56380:6379\']\n        options: >-\n          --health-cmd "redis-cli ping"\n          --health-interval 1s --health-timeout 3s --health-retries 30\n';
// Restore only the process lane addition; the identical integration service is historical.
export function projectComparisonCiWorkflow(bytes) {
 bytes = projectAnnouncementArchiveInput(workflowPath, bytes);
 // #295/#337 add only comparison-document CI triggers; historical measurements stay sealed.
 if (sha(bytes) === '2d5591a5a03eae69eca95442a2e652d1ce220840683541eca4d3739c95885608') {
  let previous = bytes.toString();
  for (const path of ['role-public', 'announcements']) {
   const addition = `      - 'docs/superpowers/compatibility/${path}/**'\n`;
   assert.equal(previous.split(addition).length, 3, 'folder exact comparison CI paths');
   previous = previous.replaceAll(addition, '');
  }
  bytes = Buffer.from(previous);
 }

 return bytes;
}
function workflowBeforeCheckConnectRedis(bytes) {
 bytes = projectComparisonCiWorkflow(bytes);
 assert.equal(sha(bytes), 'cf0c9ed1621aedef3eef678588bd83e0789a88ac1b2d315826c7731a67de4931', 'folder measured current input drift (notes contract CI workflow)');
 const notesPath = "      - 'docs/superpowers/compatibility/notes-pagination/**'\n";
 assert.equal(bytes.toString().split(notesPath).length, 3, 'folder exact notes CI path in push and pull request');
 bytes = Buffer.from(bytes.toString().replaceAll(notesPath, ''));
 assert.equal(sha(bytes), '522b45f35703a65febb1d1471e601a74914570b364a2e0f205ddb9e895702178', 'folder measured current input drift (process Redis workflow)');
 const sections = bytes.toString().split('  process:\n');
 assert.equal(sections.length, 2, 'folder exact process section');
 assert.equal(sections[1].split(processRedisService).length, 2, 'folder exact process Redis service');
 const previous = Buffer.from(sections[0] + '  process:\n' + sections[1].replace(processRedisService, ''));
 assert.equal(sha(previous), '41bf145751d3c3b6825e54abb9018e7dc706e0d757d08c6f2568ee3a8bd26184', 'folder exact workflow before process Redis');
 return previous;
}
// These runner-only additions do not renew the historical Pub/Sub measurement.
function workflowBeforeVideoFfmpeg(bytes) {
 bytes = workflowBeforeCheckConnectRedis(bytes);
 assert.equal(sha(bytes), '41bf145751d3c3b6825e54abb9018e7dc706e0d757d08c6f2568ee3a8bd26184', 'folder measured current input drift (video FFmpeg workflow)');
 const current = bytes.toString();
 assert.equal(current.split(videoFfmpegStep).length, 2, 'folder exact video FFmpeg step');
 const previous = Buffer.from(current.replace(videoFfmpegStep, ''));
 assert.equal(sha(previous), 'ec6a28293c8168387f5247a91b666b10a1ff98d816b7e55b58f8c4a98bb74426', 'folder exact workflow before video FFmpeg');
 return previous;
}
export function validateDriveFolderPubsubSuccessor(value, rawRead = read, optional = optionalRead) {
 return scopedEvidenceValidation(validateDriveFolderPubsubSuccessor, value, rawRead, optional, (rawRead, optional) => {
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
 for (const [path, digest] of Object.entries(value.inputs)) {
  const current = readFile(path);
  assert.equal(sha(path === workflowPath ? workflowBeforeVideoFfmpeg(current) : current), digest, `folder measured current input drift (pubsub successor): ${path}`);
 }
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
 });
}
export function readPreDriveFolderPubsub(path, encoding, readFile = read, optional = optionalRead) {
 return withEvidenceRequestedPath(path, () => {
 const bytes = pubsubSuccessorFiles.includes(path) ? Buffer.from(validateDriveFolderPubsubSuccessor(undefined, readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
 });
}
