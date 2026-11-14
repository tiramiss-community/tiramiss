/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readPreOutbox } from './local-outbox-evidence.mjs';

const root = new URL('../', import.meta.url);
const evidencePath = 'docs/superpowers/compatibility/remote-user/local-actor-alias-key-current-evidence.json';
const seal = '914dba37a53426d0b7037a8478b7eb1680a5b43292a609ae137232033e91e5e0';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const predecessorPath = 'docs/superpowers/compatibility/remote-user/local-actor-alias-key-predecessor.json';
const predecessorSeal = '03a97fcc535ca09beefd3360cfdac8b647d3d5c6d087003f268729f62f67bd37';
export const successorFiles = Object.freeze([
 "packages/backend-next/src/composition/actor-http.ts",
 "packages/backend-next/src/http/activitypub-actor-api.ts",
 "packages/backend-next/src/modules/federation/local-actor.ts",
 "packages/backend-next/src/modules/federation/public.ts",
 "packages/backend-next/src/platform/database/local-actors.ts",
 "packages/backend-next/test/unit/composition/http-app.test.ts"
]);
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'alias-key successor record seal');
 return JSON.parse(bytes);
}

export function validateAliasKeySuccessor(value = record(read), rawRead = read, optional = optionalRead) {
 const readFile = path => readPreOutbox(path, undefined, rawRead, optional);
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'alias-key successor record seal');
 assert.deepEqual(Object.keys(value.files), successorFiles, 'alias-key finite subset');
 assert.equal(value.implementationCommit, '43e72c7b6f1394fe6685eeca2ff368a6bd641d6f');
 assert.equal(value.predecessorCommit, 'f4bb7803a814a112b18286d4ca1b0cfb71e5787e');
 assert.equal(value.regression.runtimeCommit, 'ed83098e343983f3c3a24762f4edd2a125d83c99');
 assert.equal(value.regression.exitCode, 0);
 assert.equal(value.regression.tests, 614);
 const receipt = value.receipt;
 assert.equal(receipt.runtimeCommit, value.implementationCommit);
 assert.deepEqual(Object.keys(receipt.runs), ['build', 'typecheck', 'units', 'db-http', 'source', 'structural', 'shipping', 'sync']);
 for (const [path, digest] of Object.entries(receipt.sourceInputs)) {
  assert.equal(sha(readFile(path)), digest, 'alias-key measured current input drift');
 }
 for (const [path, binding] of Object.entries(value.files)) {
  assert.equal(binding.sha256, receipt.sourceInputs[path], 'alias-key measured binding');
  assert.deepEqual(binding.validatedBy, path.includes('/test/unit/') ? ['units'] : ['build', 'typecheck', 'units', 'db-http'], 'alias-key applicable suites');
  assert.equal(sha(predecessorBytes(value, path, readFile)), binding.previousSha256, 'alias-key historical input drift');
 }
 for (const [id, run] of Object.entries(receipt.runs)) {
  assert.equal(run.exitCode, 0, 'alias-key successful measurement');
  assert.equal(run.tests, ({units:1927, 'db-http':216, source:172, structural:5})[id] ?? null);
  const bytes = optional(run.commandLog);
  if (bytes !== null) assert.equal(sha(bytes), run.logSha256, 'alias-key actual log drift');
 }
 for (const [path, digest] of [
  ['/tmp/tiramiss-s1-323-20261114/runtime-receipt.json', sha(Buffer.from(JSON.stringify(receipt, null, 2) + '\n'))],
  [value.regression.commandLog, value.regression.logSha256],
  ['/tmp/tiramiss-s1-323-20261114/regression-receipt.json', sha(Buffer.from(JSON.stringify(value.regression, null, 2) + '\n'))],
 ]) {
  const bytes = optional(path);
  if (bytes !== null) assert.equal(sha(bytes), digest, 'alias-key actual receipt/log drift');
 }
}
function predecessorBytes(value, path, readFile = read) {
 const fixture = readFile(predecessorPath);
 assert.equal(sha(fixture), predecessorSeal, 'alias-key historical fixture drift');
 const historical = JSON.parse(fixture);
 assert.equal(historical.commit, value.predecessorCommit);
 assert.deepEqual(Object.keys(historical.files), successorFiles);
 const bytes = Buffer.from(historical.files[path]);
 assert.equal(sha(bytes), value.files[path].previousSha256, 'alias-key historical input drift');
 return bytes;
}

// Dated proofs retain their pre-323 projection. Only these six consumers may
// cross the boundary, and each read first verifies the measured live bytes.
// All other paths (including corpora and receipts) remain ordinary live reads.
export function readPreAliasKey(path, encoding, rawRead = read) {
 const readFile = path => readPreOutbox(path, undefined, rawRead);
 if (!successorFiles.includes(path)) {
  const bytes = readFile(path);
  return encoding ? bytes.toString(encoding) : bytes;
 }
 const value = record(readFile);
 assert.equal(sha(readFile(path)), value.files[path].sha256, 'alias-key current source/test drift');
 const bytes = predecessorBytes(value, path, readFile);
 return encoding ? bytes.toString(encoding) : bytes;
}
