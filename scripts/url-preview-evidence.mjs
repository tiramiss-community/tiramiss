/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readForActorEmojiCacheEvidence } from './actor-emoji-cache-evidence.mjs';
import { readBeforeNotesPagination } from './notes-pagination-evidence.mjs';
import { scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';
import { createPreImageIngestDependencyReader } from './image-ingest-dependency-evidence.mjs';
import { ciFixtureFiles, readPreMetaCacheCiFixtures } from './meta-cache-ci-fixtures-evidence.mjs';
import { driveFilePredecessorFiles, readPreDriveFiles } from './drive-files-evidence.mjs';
import { metaCachePredecessorFiles, readPreMetaCache, createValidatedMetaPredecessorReader } from './meta-cache-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hasInternalEventPredecessor, readPreInternalEvents, validateInternalEventsSuccessor } from './internal-events-evidence.mjs';
import { readPrePreviewFixture } from './url-preview-fixture-evidence.mjs';
import { validateDriveFoldersSuccessor } from './drive-folders-evidence.mjs';
import { pubsubSuccessorFiles, readPreDriveFolderPubsub } from './drive-folder-pubsub-evidence.mjs';

const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/url-preview/';
const evidencePath = directory + 'current-evidence.json';
const predecessorPath = directory + 'predecessor.json';
const receiptPath = '/tmp/tiramiss-s1-377-20261115/product-run-receipt.json';
const seal = 'b62bd5348c84d0c9f8f8e098400782eeca9264d8cfb3cbea03bf08c89252f501';
const predecessorSeal = 'b6d063b15d0075358a74d6280b9f4cc8459cf38e1beaab864107c5d927ef46a5';
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
 'packages/backend-next/src/platform/connect-resources.ts',
 'packages/backend-next/test/unit/composition/http-app.test.ts',
 'packages/backend-next/package.json',
 'packages/backend-next/src/application/outbound-http.ts',
 'packages/backend-next/src/composition/outbound-http.ts',
 'packages/backend-next/src/platform/outbound-http/client.ts',
 'pnpm-lock.yaml',
]);
const parsedSealed = new Map();
let historicalLock;
function parseSealed(bytes, digest) {
 if (!parsedSealed.has(digest)) parsedSealed.set(digest, JSON.parse(bytes));
 return parsedSealed.get(digest);
}
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'URL preview current receipt seal');
 return parseSealed(bytes, seal);
}

// A finite terminal hop for #377/#560. Historical receipts remain byte-for-byte
// immutable; only eight measured changed inputs are restored for their readers.
export function validateUrlPreviewSuccessor(value, readFile = read, optional = optionalRead) {
 return scopedEvidenceValidation(validateUrlPreviewSuccessor, value, readFile, optional, (readFile, optional) => {
 const liveRead = readFile;
 readFile = createPreImageIngestDependencyReader(readFile);
 const beforeMeta = createValidatedMetaPredecessorReader(readFile, optional);
 const previousInternalEvents = validateInternalEventsSuccessor(undefined, readFile, optional);
 const readBeforeInternalEvents = readFile;
 readFile = path => Object.hasOwn(previousInternalEvents, path) ? Buffer.from(previousInternalEvents[path]) : readBeforeInternalEvents(path);
 if (value === undefined) value = record(readFile);
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'URL preview current receipt seal');
 assert.equal(value.runtimeRevision, '4047f7fc8696ee45104d0ed317722273afbcce1e');
 assert.equal(value.baseRevision, 'fa57cedcd7923e02144eedc4fbec50bbda8b333d');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(Object.keys(value.inputs).length, 27);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 const previousFolders = validateDriveFoldersSuccessor(undefined, readBeforeInternalEvents, optional);
 readFile = path => path in previousFolders ? Buffer.from(previousFolders[path]) : Object.hasOwn(previousInternalEvents, path) ? Buffer.from(previousInternalEvents[path]) : beforeMeta(path);
 for (const [path, digest] of Object.entries(value.inputs)) {
  const bytes = path === 'packages/backend-next/src/modules/note/public.ts' ? readBeforeNotesPagination(path, liveRead, optional) : readFile(path);
  assert.equal(sha(bytes), digest, `instance admin measured current input drift (URL preview successor): ${path}`);
 }
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'URL preview predecessor seal');
 const previous = parseSealed(bytes, predecessorSeal);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), successorFiles.filter(path => path !== 'pnpm-lock.yaml'));
 const patch = previous.lockPatch;
 assert.equal(patch.path, 'pnpm-lock.yaml');
 assert.equal(patch.currentSha256, value.inputs[patch.path]);
 const actualLock = readFile(patch.path);
 const actualLockSha = sha(actualLock);
 assert.equal(actualLockSha, patch.currentSha256, 'URL preview exact historical lock identity');
 let previousLock;
 if (historicalLock?.sha === actualLockSha) {
  previousLock = historicalLock.value;
 } else {
  const currentLock = actualLock.toString();
  assert.equal(currentLock.split(patch.before).length, 2, 'URL preview lock patch has one exact anchor');
  previousLock = currentLock.replace(patch.before, patch.after);
  assert.equal(sha(Buffer.from(previousLock)), patch.previousSha256, 'URL preview exact historical lock identity');
  historicalLock = { sha: actualLockSha, value: previousLock };
 }
 const projected = { ...previous.files, [patch.path]: previousLock };
 assert.deepEqual(Object.keys(projected), successorFiles);
 for (const path of successorFiles) assert.notEqual(sha(Buffer.from(projected[path])), value.inputs[path]);
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'process', 'source', 'sync']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'URL preview actual log drift');
   if (['unit', 'integration', 'process'].includes(run.name)) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') assert(bytes.toString().includes('59 cases / 174 requests --check PASS'));
  }
 }
 const actual = optional(receiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'URL preview actual receipt drift');
 return projected;
 });
}

export function readPreUrlPreview(path, encoding, readFile = read, optional = optionalRead) {
 return withEvidenceRequestedPath(path, () => {
 if (ciFixtureFiles.includes(path)) {
  return readPreMetaCacheCiFixtures(path, encoding, readFile, optional);
 }
 if (driveFilePredecessorFiles.includes(path) && !successorFiles.includes(path)) return readPreDriveFiles(path, encoding, readFile);
 if (metaCachePredecessorFiles.includes(path) && !successorFiles.includes(path) && !hasInternalEventPredecessor(path) && !pubsubSuccessorFiles.includes(path)) {
  return readPreMetaCache(path, encoding, readFile, optional);
 }
 if (pubsubSuccessorFiles.includes(path)) return readPreDriveFolderPubsub(path, encoding, readFile, optional);
 const bytes = successorFiles.includes(path) ? Buffer.from(validateUrlPreviewSuccessor(record(readFile), readFile, optional)[path]) : hasInternalEventPredecessor(path) ? readPreInternalEvents(path, undefined, readFile, optional) : readPrePreviewFixture(path, undefined, file => readForActorEmojiCacheEvidence(file, readFile, optional), optional);
 return encoding ? bytes.toString(encoding) : bytes;
 });
}
