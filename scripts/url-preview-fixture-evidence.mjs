/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/url-preview/';
const evidencePath = directory + 'fixture-correction-evidence.json';
const predecessorPath = directory + 'fixture-correction-predecessor.json';
const receiptPath = '/tmp/tiramiss-s1-377-20261115/fixture-correction-receipt.json';
const seal = '183baee90cbb86c2c822448ca05682758737a504285d81bb6e79a8072a17d0ff';
const predecessorSeal = '46fda05d6becd463ddb816d74b1df50e3259496c34553ecfe0fe7e55277bb2a7';
const read = path => readFileSync(new URL(path, root));
const sha = value => createHash('sha256').update(value).digest('hex');
const optionalRead = path => {
 try { return readFileSync(path); } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
};
export const fixturePath = 'packages/backend-next/test/unit/remote-emoji-resources.test.ts';
function record(readFile) {
 const bytes = readFile(evidencePath);
 assert.equal(sha(bytes), seal, 'preview mock correction receipt seal');
 return JSON.parse(bytes);
}
export function validatePreviewFixture(value, readFile = read, optional = optionalRead) {
 if (value === undefined) value = record(readFile);
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), seal, 'preview mock correction receipt seal');
 assert.equal(value.baseRevision, 'e972af7583aef146d7c77a6692b6387b896dff48');
 assert.equal(value.measuredWorkingTree, true);
 assert.equal(value.failedCi.runId, 43650059099);
 assert.equal(value.failedCi.jobId, 132616298876);
 assert.deepEqual(Object.keys(value.inputs), [fixturePath]);
 assert.equal(value.noInputDrift, true);
 assert.deepEqual(value.inputsAfter, value.inputs);
 assert.equal(sha(readFile(fixturePath)), value.inputs[fixturePath], 'preview mock correction measured input drift');
 const bytes = readFile(predecessorPath);
 assert.equal(sha(bytes), predecessorSeal, 'preview mock correction predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, value.baseRevision);
 assert.deepEqual(Object.keys(previous.files), [fixturePath]);
 assert.equal(sha(Buffer.from(previous.files[fixturePath])), '0e91899d797f7a9e94930966ce4e909f24d6054872ffbfe5ecd176146efd5f78');
 assert.notEqual(sha(Buffer.from(previous.files[fixturePath])), value.inputs[fixturePath]);
 assert.deepEqual(value.runs.map(run => run.name), ['focused', 'full-unit', 'shipping']);
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'preview mock correction actual log drift');
   if (run.passed !== undefined) {
    assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
    assert(bytes.toString().includes(`Test Files  ${run.files} passed (${run.files})`));
   }
  }
 }
 const receipt = optional(receiptPath);
 if (receipt !== null) assert.equal(sha(receipt), seal, 'preview mock correction actual receipt drift');
 return previous.files;
}
export function readPrePreviewFixture(path, encoding, readFile = read, optional = optionalRead) {
 const bytes = path === postSaveFixturePath ? Buffer.from(validatePostSaveIdleFixture(undefined, readFile, optional)) : path === fixturePath ? Buffer.from(validatePreviewFixture(record(readFile), readFile, optional)[path]) : readFile(path);
 return encoding ? bytes.toString(encoding) : bytes;
}

export const postSaveFixturePath = 'packages/backend-next/test/unit/note/post-save.test.ts';
const postSaveProductionPath = 'packages/backend-next/src/platform/note-post-save.ts';
const postSaveEvidencePath = 'docs/superpowers/compatibility/actor-emoji-cache/post-save-idle-fixture-evidence.json';
const postSaveSeal = '8292346647ca19a292a443981b8da488cbbbae38628c9644bcf664bfd2d3aac1';
// One unrelated CI fixture changes; old runtime measurements remain immutable.
export function validatePostSaveIdleFixture(value, readFile = read, optional = optionalRead) {
 if (value === undefined) {
  const bytes = readFile(postSaveEvidencePath);
  assert.equal(sha(bytes), postSaveSeal, 'post-save idle fixture receipt seal'); value = JSON.parse(bytes);
 }
 assert.equal(sha(Buffer.from(JSON.stringify(value, null, 2) + '\n')), postSaveSeal, 'post-save idle fixture receipt seal');
 assert.equal(value.scope, 'post-save-idle-ci-fixture');
 assert.equal(value.baseRevision, 'bb41a9d36bd17261df666e6813cc6029fef2618b');
 assert.equal(value.productionChanged, false); assert.equal(value.noInputDrift, true);
 assert.equal(value.postingComplete, false); assert.equal(value.ciSuccessMeasured, false);
 assert.deepEqual(Object.keys(value.inputs), [postSaveFixturePath, postSaveProductionPath]);
 assert.deepEqual(value.inputsAfter, value.inputs);
 for (const [path, digest] of Object.entries(value.inputs)) assert.equal(sha(projectPostSaveChartInput(path, readFile(path))), digest, `post-save idle fixture measured input drift: ${path}`);
 const previous = value.predecessor;
 assert.equal(previous.path, postSaveFixturePath);
 assert.equal(previous.currentSha256, value.inputs[postSaveFixturePath]);
 assert.equal(previous.previousSha256, '4e529c8dd7508a5a862cdb7f3c0c820a5fda093dfc52da050c92200382a9c42b');
 let source = readFile(postSaveFixturePath).toString();
 for (const patch of [...previous.patches].reverse()) {
  assert.equal(source.slice(patch.offset, patch.offset + patch.before.length), patch.before, 'post-save idle fixture exact patch');
  source = source.slice(0, patch.offset) + patch.after + source.slice(patch.offset + patch.before.length);
 }
 assert.equal(sha(Buffer.from(source)), previous.previousSha256, 'post-save idle fixture predecessor identity');
 assert.equal(value.mutant.exitCode, 1);
 assert.deepEqual(value.runs.map(run => run.name), ['post-save-focused', ...Array.from({ length: 10 }, (_, index) => `post-save-repeat-${String(index + 1).padStart(2, '0')}`)]);
 assert(value.runs.every(run => run.passed === 14 && run.files === 1));
 for (const run of value.runs) {
  assert.equal(run.exitCode, 0);
  const bytes = optional(run.log);
  if (bytes !== null) {
   assert.equal(sha(bytes), run.logSha256, 'post-save idle fixture actual log drift');
   if (run.passed !== undefined) assert(bytes.toString().includes(`Tests  ${run.passed} passed (${run.passed})`));
  }
 }
 for (const run of [value.failedCi, value.mutant]) {
  const bytes = optional(run.log);
  if (bytes !== null) assert.equal(sha(bytes), run.logSha256, 'post-save idle fixture actual log drift');
 }
 return source;
}

// Keep this standalone fixture leaf builtins-only. #274's separately measured
// producer adds these exact chart dispatch bytes; the old idle receipt is history.
function projectPostSaveChartInput(path, actual) {
 if (path !== postSaveProductionPath || sha(actual) !== 'e70abe9b1693b2a7c681075fc674257c62f2ed7d6f373a8ec16175fd1e8873c0') return actual;
 let previous = actual.toString();
 for (const addition of [
  '\tcharts?(input: NotePostSaveInput): Promise<void>;\n',
  "\t\tif (steps.charts) {\n\t\t\tstart('charts', () => steps.charts!(input));\n\t\t}\n",
 ]) {
  assert.equal(previous.split(addition).length, 2, 'post-save chart predecessor anchor');
  previous = previous.replace(addition, '');
 }
 assert.equal(sha(Buffer.from(previous)), 'af4b441de6527947089c2b701a6b851b356e6bc2e5e1a144638fa305e86771b2', 'post-save chart predecessor identity');
 return Buffer.from(previous);
}
