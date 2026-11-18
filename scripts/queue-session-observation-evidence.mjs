/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectAnnouncementArchiveInput } from './announcement-archive-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/internal-events/';
const evidencePath = directory + 'queue-session-observation-evidence.json';
const predecessorPath = directory + 'queue-session-observation-predecessor.json';
const actualReceiptPath = '/tmp/tiramiss-s1-round2-20261115/290/ci-process/fixture-run-receipt.json';
const seal = '668608b3c20f2778ee294912813e5b801784b13a223af236a17b4f812e43a926';
const predecessorSeal = '76cd1c64b8a5255f0db1576123591093a2d1159059ad1855b2435e417434a835';
export const queueSessionObservationPath = 'packages/backend-next/test/processes/queue-runtime.test.ts';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parsed = new Map();
function sealed(bytes, digest, name) {
 assert.equal(sha(bytes), digest, `queue session observation ${name} seal`);
 if (!parsed.has(digest)) parsed.set(digest, JSON.parse(bytes));
 return parsed.get(digest);
}
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export function validateQueueSessionObservation(value, readFile = read, optional = optionalRead) {
 if (value === undefined) value = sealed(readFile(evidencePath), seal, 'receipt');
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'queue session observation receipt seal');
 assert.equal(value.fixtureRevision, 'c261d11765fac7452d16f45eae8986584a41fc10');
 assert.equal(value.baseRevision, 'cb99ebcda1c7486bd0e6172c400bb59fd99bbf33');
 assert.deepEqual(Object.keys(value.inputs), [queueSessionObservationPath]);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(sha(projectAnnouncementArchiveInput(queueSessionObservationPath, readFile(queueSessionObservationPath))), value.inputs[queueSessionObservationPath], 'queue session measured fixture input drift');
 const previous = sealed(readFile(predecessorPath), predecessorSeal, 'predecessor');
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), [queueSessionObservationPath]);
 assert.notEqual(sha(Buffer.from(previous.files[queueSessionObservationPath])), value.inputs[queueSessionObservationPath]);
 assert.equal(value.run.exitCode, 0);
 assert.equal(value.run.passed, 18);
 assert.equal(value.run.files, 1);
 const log = optional(value.run.log);
 if (log !== null) {
  assert.equal(sha(log), value.run.logSha256, 'queue session actual log drift');
  assert(log.toString().includes('Tests  18 passed (18)'));
  assert(log.toString().includes('Test Files  1 passed (1)'));
 }
 const actual = optional(actualReceiptPath);
 if (actual !== null) assert.equal(sha(actual), seal, 'queue session actual receipt drift');
 const probe = optional(value.controlledCounterexample.log);
 if (probe !== null) assert.equal(sha(probe), value.controlledCounterexample.logSha256, 'queue session actual counterexample drift');
 return { ...previous.files };
}
export function readPreQueueSessionObservation(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = path === queueSessionObservationPath ? Buffer.from(validateQueueSessionObservation(undefined, readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}
