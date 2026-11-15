/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/internal-events/';
const evidencePath = directory + 'current-evidence.json';
const predecessorPath = directory + 'predecessor.json';
const receiptPath = '/tmp/tiramiss-s1-round2-20261115/290/product-run-receipt.json';
const seal = 'b820fb2c87bc5de6248a08f2ea0eccf8e865eea5224b0be5dbe42eeee6e2fe1f';
const predecessorSeal = '5978577d2ce3dfe143a57e3346498c1a6207340eb5b05a16c5e20656b9ddeda9';
const runtimeRevision = '00d2a724bbb082ab27b7ade6c47d5906a63cd3df';
const projectedPath = 'packages/backend-next/src/platform/connect-resources.ts';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parsed = new Map();
function sealed(bytes, digest, name) {
 assert.equal(sha(bytes), digest, `internal events ${name} seal`);
 if (!parsed.has(digest)) parsed.set(digest, JSON.parse(bytes));
 return parsed.get(digest);
}
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
// A finite, disjoint successor for the one changed shared composition file.
// Cached parsing never replaces reads or hashes through the caller's reader.
export function validateInternalEventsSuccessor(value, readFile = read, optional = optionalRead) {
 if (value === undefined) value = sealed(readFile(evidencePath), seal, 'receipt');
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'internal events receipt seal');
 assert.equal(value.runtimeRevision, runtimeRevision);
 assert.equal(value.baseRevision, '86fce3926f97d2b62d790ff1e44449a57c2d33ee');
 assert.equal(value.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(Object.keys(value.inputs).length, 21);
 for (const [path, digest] of Object.entries(value.inputs)) {
  assert.equal(sha(readFile(path)), digest, `internal events measured current input drift: ${path}`);
 }
 const previous = sealed(readFile(predecessorPath), predecessorSeal, 'predecessor');
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), [projectedPath]);
 assert.notEqual(sha(Buffer.from(previous.files[projectedPath])), value.inputs[projectedPath]);
 assert.deepEqual(value.runs.map(run => run.name), ['build', 'typecheck', 'unit', 'integration', 'process', 'source', 'sync']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'internal events actual log drift');
   if (run.passed !== undefined) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
   if (run.name === 'source') assert(bytes.toString().includes('PASS: 15 pinned source event projections'));
  }
 }
 const actual = optional(receiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'internal events actual receipt drift');
 return { ...previous.files };
}
export function readPreInternalEvents(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = path === projectedPath ? Buffer.from(validateInternalEventsSuccessor(undefined, readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
