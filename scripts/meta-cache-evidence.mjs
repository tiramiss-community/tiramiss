/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/meta-cache/';
const seal = 'e8cc0d48df6e8106a613ee696c93f4ccddc618f0dfcdd01d19101b8566a46781';
const predecessorSeal = 'a42857e97f501a7c489b748e4157b36e2af53803f3f82b1b1ae2eb0e58989d0b';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL(path, root));
const optionalRead = path => {
 try {
  return readFileSync(path);
 } catch (error) {
  if (error.code === 'ENOENT') {
   return null;
  }
  throw error;
 }
};
const parsed = new Map();
function sealed(bytes, digest, name) {
 assert.equal(sha(bytes), digest, `Meta cache ${name} seal`);
 if (!parsed.has(digest)) {
  parsed.set(digest, JSON.parse(bytes));
 }
 return parsed.get(digest);
}
export const metaCachePredecessorFiles = Object.freeze([
 "packages/backend-next/src/composition/actor-http.ts",
 "packages/backend-next/src/composition/actor-instance-registration.ts",
 "packages/backend-next/src/composition/deliver-job.ts",
 "packages/backend-next/src/composition/emoji-http.ts",
 "packages/backend-next/src/composition/featured-http.ts",
 "packages/backend-next/src/composition/follow-collections-http.ts",
 "packages/backend-next/src/composition/local-actor-materials.ts",
 "packages/backend-next/src/composition/outbox-http.ts",
 "packages/backend-next/src/composition/remote-users.ts",
 "packages/backend-next/src/composition/webfinger-http.ts",
 "packages/backend-next/src/modules/federation/deliver-job.ts",
 "packages/backend-next/src/platform/connect-resources.ts",
 "packages/backend-next/src/platform/database/meta.ts",
 "packages/backend-next/test/integration/activitypub-actor.test.ts",
 "packages/backend-next/test/integration/http-app.test.ts",
 "packages/backend-next/test/integration/local-emoji-object-http.test.ts",
 "packages/backend-next/test/integration/local-featured-http.test.ts",
 "packages/backend-next/test/integration/local-follow-collections-http.test.ts",
 "packages/backend-next/test/integration/local-outbox-http.test.ts",
 "packages/backend-next/test/integration/webfinger.test.ts",
 "packages/backend-next/test/unit/composition/http-app.test.ts",
 "packages/backend-next/test/unit/federation/acquisition-policy.test.ts",
 "packages/backend-next/test/unit/federation/local-actor-images.test.ts",
 "packages/backend-next/test/unit/federation/local-featured-red.test.ts",
 "packages/backend-next/test/unit/federation/remote-emojis.test.ts",
 "packages/backend-next/test/unit/federation/remote-profile.test.ts",
 "packages/backend-next/test/unit/federation/remote-user.test.ts"
]);

// This one bounded transition preserves historical measurements; it does not renew them.
// Cached parsing never skips an actual read/hash through the caller's reader.
export function validateMetaCacheSuccessor(value, readFile = read, optional = optionalRead) {
 if (value === undefined) {
  value = sealed(readFile(directory + 'current-evidence.json'), seal, 'receipt');
 }
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'Meta cache receipt seal');
 assert.equal(value.baseRevision, '1adb04b0cf4d6efdb2537891df4ca2261359f1f6');
 assert.equal(value.runtimeRevision, '1a7ff81026441b262d37c8171d381d39c45deddf');
 assert.equal(value.measurementRevision, '529ff21ba56e6cbd6e0c58aad980b2f854cd550f');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(Object.keys(value.inputs).length, 33);
 assert.equal(value.postingComplete, false);
 assert.equal(value.upstreamFullServerMeasured, false);
 for (const [path, digest] of Object.entries(value.inputs)) {
  assert.equal(sha(readFile(path)), digest, `Meta cache measured current input drift: ${path}`);
 }
 const previous = sealed(readFile(directory + 'predecessor.json'), predecessorSeal, 'predecessor');
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), metaCachePredecessorFiles);
 for (const path of metaCachePredecessorFiles) {
  assert.notEqual(sha(Buffer.from(previous.files[path])), value.inputs[path]);
 }
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'source', 'sync']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const log = optional(run.log);
  if (log !== null) {
   assert.equal(sha(log), run.logSha256, 'Meta cache actual log drift');
   if (run.passed !== undefined) {
    assert(log.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(log.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') {
    assert(log.toString().includes('PASS: 9 pinned MetaService observations and stop'));
   }
  }
 }
 return { ...previous.files };
}
// A closure belongs to one synchronous validator invocation. It never stores a
// validation result for the next public call, and still checks each requested input.
export function createValidatedMetaPredecessorReader(readFile = read, optional = optionalRead) {
 const previous = validateMetaCacheSuccessor(undefined, readFile, optional);
 const current = sealed(readFile(directory + 'current-evidence.json'), seal, 'receipt');
 return (path, encoding) => {
  const actual = readFile(path);
  if (Object.hasOwn(current.inputs, path)) {
   assert.equal(sha(actual), current.inputs[path], `Meta cache measured current input drift: ${path}`);
  }
  const bytes = Object.hasOwn(previous, path) ? Buffer.from(previous[path]) : actual;
  return encoding ? bytes.toString(encoding) : bytes;
 };
}
export function readPreMetaCache(path, encoding, readFile = read, optional = optionalRead) {
 if (!metaCachePredecessorFiles.includes(path)) {
  const bytes = readFile(path);
  return encoding ? bytes.toString(encoding) : bytes;
 }
 return createValidatedMetaPredecessorReader(readFile, optional)(path, encoding);
}
