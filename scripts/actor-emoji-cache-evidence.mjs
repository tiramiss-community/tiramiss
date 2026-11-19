/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectAnnouncementArchiveInput } from './announcement-archive-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readPreMetaInitialization } from './meta-initialization-evidence.mjs';
import { projectNotesPaginationInput } from './notes-pagination-evidence.mjs';
import { scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';
const directory = 'docs/superpowers/compatibility/actor-emoji-cache/';
const seal = '20fcbc11ed50287c915ec771c6bcc50149ba6ec18b4453ca888aa500249ead2d';
const predecessorSeal = '8c0734e3e338987849cb52501368f25f003a2b96ae3a5c41d7334ea626eda880';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const optionalRead = path => { try { return readFileSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export const actorEmojiCacheFiles = Object.freeze([
 "packages/backend-next/src/composition/actor-http.ts",
 "packages/backend-next/src/composition/local-actor-tags.ts",
 "packages/backend-next/src/composition/note-routes.ts",
 "packages/backend-next/src/composition/posting-notifications.ts",
 "packages/backend-next/src/composition/posting-websocket.ts",
 "packages/backend-next/src/composition/remote-users.ts",
 "packages/backend-next/src/modules/note/render-note.ts",
 "packages/backend-next/src/platform/connect-resources.ts",
 "packages/backend-next/src/platform/database/note-authors.ts",
 "packages/backend-next/src/platform/database/note-reader.ts",
 "packages/backend-next/src/platform/database/streaming.ts",
 "packages/backend-next/test/integration/activitypub-actor.test.ts"
]);
function record(readFile) {
 const bytes = readFile(directory + 'current-evidence.json');
 assert.equal(sha(bytes), seal, 'actor emoji cache receipt seal');
 return JSON.parse(bytes);
}
export function validateActorEmojiCacheEvidence(value, rawRead = read, optional = optionalRead) {
 return scopedEvidenceValidation(validateActorEmojiCacheEvidence, value, rawRead, optional, (rawRead, optional) => {
  const currentRead = rawRead;
  rawRead = path => actorEmojiBatchFiles.includes(path) ? readBeforeActorEmojiBatch(path, currentRead, optional) : projectNotesPaginationInput(path, projectStreamCredentialInput(path, projectAnnouncementArchiveInput(path, currentRead(path))));
  if (value === undefined) value = record(rawRead);
  assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'actor emoji cache receipt seal');
  assert.equal(value.scope, 'actor-emoji-cache-303');
  assert.equal(value.baseRevision, '5f0549ad96af7ce85e12fdcc4bf26f23b029d29d');
  assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
  assert.equal(value.measuredWorkingTree, true); assert.equal(value.noInputDrift, true);
  assert.equal(value.postingComplete, false); assert.equal(value.upstreamFullServerMeasured, false);
  assert.deepEqual(value.inputsAfter, value.inputs);
  for (const [path, hash] of Object.entries(value.inputs)) {
   assert(!/package\.json$|pnpm-lock|backend-inventory/.test(path), 'actor proof excludes independent dependency/inventory inputs');
   assert.equal(sha(rawRead(path)), hash, `Meta cache measured current input drift (actor emoji cache): ${path}`);
  }
  const bytes = rawRead(directory + 'predecessor.json');
  assert.equal(sha(bytes), predecessorSeal, 'actor emoji cache predecessor seal');
  const previous = JSON.parse(bytes); assert.equal(previous.baseRevision, value.baseRevision);
  assert.deepEqual(Object.keys(previous.files), actorEmojiCacheFiles);
  const result = {};
  for (const [path, binding] of Object.entries(previous.files)) {
   assert.equal(binding.currentSha256, value.inputs[path]);
   let current = rawRead(path).toString();
   assert.equal(sha(Buffer.from(current)), binding.currentSha256, `Meta cache measured current input drift (actor emoji cache): ${path}`);
   for (const patch of [...binding.patches].reverse()) {
    assert.equal(current.slice(patch.offset, patch.offset + patch.before.length), patch.before, 'actor emoji cache exact predecessor patch');
    current = current.slice(0, patch.offset) + patch.after + current.slice(patch.offset + patch.before.length);
   }
   assert.equal(sha(Buffer.from(current)), binding.previousSha256, 'actor emoji cache exact predecessor identity');
   result[path] = current;
  }
  assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'process', 'source']);
  for (const run of value.runs) {
   assert.equal(run.exitCode, 0);
   const bytes = optional(run.log);
   if (bytes !== null) {
    assert.equal(sha(bytes), run.logSha256, 'actor emoji cache actual log drift');
    if (run.passed !== undefined) assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`), 'actor emoji cache actual test count');
   }
  }
  return result;
 });
}
// Consumers pass their original current-byte reader; returned bytes are a view,
// never fed back as current input. Every fresh call retains full drift checks.
export function readForActorEmojiCacheEvidence(path, rawRead = read, optional = optionalRead) {
 return withEvidenceRequestedPath(path, () => {
  if (!actorEmojiCacheFiles.includes(path)) return readPreMetaInitialization(path, rawRead, optional);
  return Buffer.from(validateActorEmojiCacheEvidence(undefined, rawRead, optional)[path]);
 });
}

const batchSeal = '399d640e557c197e0da9c68287f59774dcac06a23e055dac1cb4d01ec3efa44a';
const batchPredecessorSeal = 'd7d35b2e3946fc27b8468fda4a7ffdab3218f7fad462d62b0f186b1519199761';
export const actorEmojiBatchFiles = Object.freeze([
 'packages/backend-next/src/platform/actor-emoji-cache.ts',
 'packages/backend-next/src/platform/database/note-reader.ts',
 'packages/backend-next/test/unit/actor-emoji-cache.test.ts',
]);
// This bounded follow-up restores only three changed inputs for the original
// actor receipt. The original18-input measurement and every historical seal stay unchanged.
export function validateActorEmojiBatchEvidence(value, rawRead = read, optional = optionalRead) {
 return scopedEvidenceValidation(validateActorEmojiBatchEvidence, value, rawRead, optional, (rawRead, optional) => {
  const currentRead = rawRead;
  rawRead = path => projectNotesPaginationInput(path, currentRead(path));
  if (value === undefined) {
   const bytes = rawRead(directory + 'batch-current-evidence.json');
   assert.equal(sha(bytes), batchSeal, 'actor emoji batch receipt seal');
   value = JSON.parse(bytes);
  }
  assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), batchSeal, 'actor emoji batch receipt seal');
  assert.equal(value.scope, 'actor-emoji-cache-303-batch');
  assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
  assert.equal(value.baseRevision, '4821531ad53285c26a294387318c4decc82a0757');
  assert.equal(value.noInputDrift, true); assert.equal(value.postingComplete, false);
  assert.equal(value.upstreamFullServerMeasured, false);
  assert.deepEqual(value.inputsAfter, value.inputs);
  assert.equal(Object.keys(value.inputs).length, 7);
  for (const [path, hash] of Object.entries(value.inputs)) {
   assert.equal(sha(rawRead(path)), hash, `Meta cache measured current input drift (actor emoji batch): ${path}`);
  }
  const bytes = rawRead(directory + 'batch-predecessor.json');
  assert.equal(sha(bytes), batchPredecessorSeal, 'actor emoji batch predecessor seal');
  const previous = JSON.parse(bytes);
  assert.equal(previous.baseRevision, value.baseRevision);
  assert.deepEqual(Object.keys(previous.files), actorEmojiBatchFiles);
  const result = {};
  for (const [path, binding] of Object.entries(previous.files)) {
   assert.equal(binding.currentSha256, value.inputs[path]);
   let current = rawRead(path).toString();
   assert.equal(sha(Buffer.from(current)), binding.currentSha256, `Meta cache measured current input drift (actor emoji batch): ${path}`);
   for (const patch of [...binding.patches].reverse()) {
    assert.equal(current.slice(patch.offset, patch.offset + patch.before.length), patch.before, 'actor emoji batch exact predecessor patch');
    current = current.slice(0, patch.offset) + patch.after + current.slice(patch.offset + patch.before.length);
   }
   assert.equal(sha(Buffer.from(current)), binding.previousSha256, 'actor emoji batch exact predecessor identity'); result[path] = current;
  }
  assert.deepEqual(value.runs.map(run => run.name), ['batch-build', 'batch-typecheck', 'batch-full-unit', 'batch-integration', 'batch-process', 'batch-source']);
  assert.equal(value.regression.red.exitCode, 1); assert.equal(value.regression.green.exitCode, 0);
  for (const run of [value.regression.red, value.regression.green]) {
   const bytes = optional(run.log);
   if (bytes !== null) assert.equal(sha(bytes), run.logSha256, 'actor emoji batch actual log drift');
  }
  for (const run of value.runs) {
   assert.equal(run.exitCode, 0);
   const bytes = optional(run.log);
   if (bytes !== null) {
    assert.equal(sha(bytes), run.logSha256, 'actor emoji batch actual log drift');
    if (run.passed !== undefined) assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
   }
  }
  return result;
 });
}
function readBeforeActorEmojiBatch(path, rawRead, optional) {
 return withEvidenceRequestedPath(path, () => actorEmojiBatchFiles.includes(path) ? Buffer.from(validateActorEmojiBatchEvidence(undefined, rawRead, optional)[path]) : rawRead(path));
}

// #354 adds authentication metadata; #456 adds an independent timeline-policy port.
// Preserve archived emoji read/render bytes while rejecting every other adapter edit.
function projectStreamCredentialInput(path, actual) {
 if (path !== 'packages/backend-next/src/platform/database/streaming.ts') return actual;
 assert.equal(sha(actual), 'b3bf3528876ae5fe64afc32040e29e2fd3584431277d8b8e91177ea7310982de', `Meta cache measured current input drift (stream credential): ${path}`);
 let current = actual.toString();
 for (const line of [
  "import { readStreamingTimelinePolicies } from './streaming-timeline-policies.js';\n",
  '\t\ttimelinePolicies: (userId: string | null) => readStreamingTimelinePolicies(manager, userId, options.createdAtFromId, Date.now()),\n',
 ]) {
  assert.equal(current.split(line).length, 2, 'timeline policy exact predecessor anchor');
  current = current.replace(line, '');
 }
 assert.equal(sha(Buffer.from(current)), 'dbf359bfdff8923bff5b3ff805dca326808576d91ef14362c69ba842350dd17e', 'timeline policy exact predecessor identity');
 const addition = '\t\t\t\ttokenPermissions: caller.credential.native ? undefined : [...caller.credential.permissions],\n';
 assert.equal(current.split(addition).length, 2, 'stream credential exact predecessor anchor');
 const previous = Buffer.from(current.replace(addition, ''));
 assert.equal(sha(previous), '812f422e05bb98b4f73214ac4531bceede66f17a43c035bf4da9ce1e7add2f4a', 'stream credential exact predecessor identity');
 return previous;
}
