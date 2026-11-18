/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { projectWorkerLoggingIntegrationInput } from './worker-logging-integration-evidence.mjs';
import { scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/meta-cache/';
const seal = 'ac32204307bfd5431742de9cb58b2c08c765e5ea4ebb49323602d655e9d3b7e8';
const predecessorSeal = '9b98a89c4db145c0d9b0e1a8c0943bc21b547531f27dac6094b9201f6f9db6ed';
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
function sealed(bytes, digest, label) {
 assert.equal(sha(bytes), digest, `Meta cache CI fixture ${label} seal`);
 if (!parsed.has(digest)) {
  parsed.set(digest, JSON.parse(bytes));
 }
 return parsed.get(digest);
}
export const ciFixtureFiles = Object.freeze([
 'packages/backend-next/test/integration/actor-alias-key.test.ts',
 'packages/backend-next/test/integration/deliver-queue.test.ts',
 'packages/backend-next/test/integration/instance-metadata.test.ts',
 'packages/backend-next/test/integration/remote-user.test.ts',
 'packages/backend-next/test/unit/worker-startup.test.ts',
]);

// A separate CI-only transition leaves the measured27/33 product proof unchanged.
export function validateMetaCacheCiFixtures(value, readFile = read, optional = optionalRead) {
 return scopedEvidenceValidation(validateMetaCacheCiFixtures, value, readFile, optional, (readFile, optional) => {
 if (value === undefined) {
  value = sealed(readFile(directory + 'ci-fixtures-current-evidence.json'), seal, 'receipt');
 }
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'Meta cache CI fixture receipt seal');
 assert.equal(value.baseRevision, '0081b37c6eec96225f25ca6502b25cdbc199c0db');
 assert.equal(value.runtimeRevision, '1a7ff81026441b262d37c8171d381d39c45deddf');
 assert.equal(value.nodeVersion, '26.4.0');
 assert.equal(value.measuredWorkingTree, true);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(Object.keys(value.inputs), ciFixtureFiles);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(value.postingComplete, false);
 assert.equal(value.upstreamFullServerMeasured, false);
 for (const path of ciFixtureFiles) {
  assert.equal(sha(projectWorkerLoggingIntegrationInput(path, readFile(path), readFile)), value.inputs[path], `Meta cache measured current input drift (CI fixtures): ${path}`);
  assert.deepEqual(value.validatedBy[path], path.includes('/unit/') ? ['worker-startup', 'unit', 'typecheck'] : ['near-integration', 'integration', 'typecheck']);
 }
 const previous = sealed(readFile(directory + 'ci-fixtures-predecessor.json'), predecessorSeal, 'predecessor');
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), ciFixtureFiles);
 for (const path of ciFixtureFiles) {
  assert.notEqual(sha(Buffer.from(previous.files[path])), value.inputs[path]);
 }
 assert.deepEqual(value.runs.map(run => run.name), ['worker-startup', 'unit', 'near-integration', 'integration', 'typecheck']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  assert.equal(run.nodeVersion, '26.4.0');
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'Meta cache CI fixture actual log drift');
   if (run.passed !== undefined) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
  }
 }
 return { ...previous.files };
 });
}
export function readPreMetaCacheCiFixtures(path, encoding, readFile = read, optional = optionalRead) {
 return withEvidenceRequestedPath(path, () => {
 if (!ciFixtureFiles.includes(path)) {
  const bytes = readFile(path);
  return encoding ? bytes.toString(encoding) : bytes;
 }
 const previous = validateMetaCacheCiFixtures(undefined, readFile, optional);
 const current = sealed(readFile(directory + 'ci-fixtures-current-evidence.json'), seal, 'receipt');
 assert.equal(sha(projectWorkerLoggingIntegrationInput(path, readFile(path), readFile)), current.inputs[path], `Meta cache measured current input drift (CI fixtures): ${path}`);
 const bytes = Buffer.from(previous[path]);
 return encoding ? bytes.toString(encoding) : bytes;
 });
}
