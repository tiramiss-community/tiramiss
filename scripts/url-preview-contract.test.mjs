/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { metaCachePredecessorFiles } from './meta-cache-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readPreUrlPreview, successorFiles, validateUrlPreviewSuccessor } from './url-preview-evidence.mjs';
import { validateInstanceAdminSuccessor } from './instance-admin-evidence.mjs';
import { validateOutboxSuccessor } from './local-outbox-evidence.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/url-preview/';
const evidencePath = directory + 'current-evidence.json';
const predecessorPath = directory + 'predecessor.json';
const record = () => JSON.parse(read(evidencePath));
test('measured preview product validates online/offline and restores exactly eight historical inputs', () => {
 validateUrlPreviewSuccessor();
 const previous = validateUrlPreviewSuccessor(record(), read, () => null);
 assert.deepEqual(Object.keys(previous), successorFiles);
 const admin = JSON.parse(read('docs/superpowers/compatibility/remote-user/instance-admin-current-evidence.json'));
 assert.equal(successorFiles.length, 8);
 for (const path of successorFiles.filter(path => path in admin.inputs)) {
  assert.equal(sha(readPreUrlPreview(path)), admin.inputs[path]);
  assert.notEqual(sha(read(path)), admin.inputs[path]);
 }
 const metadata = JSON.parse(read('docs/superpowers/compatibility/instance-metadata/runtime-evidence.json'));
 for (const path of ['packages/backend-next/package.json', 'packages/backend-next/src/application/outbound-http.ts', 'packages/backend-next/src/platform/outbound-http/client.ts', 'pnpm-lock.yaml']) {
  assert.equal(sha(readPreUrlPreview(path)), metadata.measurements.integration.sourceSha256[path]);
 }
 const snapshot = JSON.parse(read(predecessorPath));
 assert.equal(Object.keys(snapshot.files).length, 7);
 assert.equal(snapshot.lockPatch.path, 'pnpm-lock.yaml');
 assert.equal(sha(readPreUrlPreview('pnpm-lock.yaml')), snapshot.lockPatch.previousSha256);
 for (const path of Object.keys(record().inputs).filter(path => !successorFiles.includes(path))) {
  if (metaCachePredecessorFiles.includes(path) || path === 'packages/backend-next/src/modules/note/public.ts') {
   assert.equal(sha(readPreUrlPreview(path)), record().inputs[path]);
  } else {
   assert.deepEqual(readPreUrlPreview(path), read(path));
  }
 }
 validateInstanceAdminSuccessor(undefined, read, () => null);
 validateOutboxSuccessor(undefined, read, () => null);
});
for (const path of Object.keys(record().inputs)) test(`rejects every measured preview input drift before historical projection: ${path}`, () => {
 const drifted = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
 assert.throws(() => validateUrlPreviewSuccessor(record(), drifted, () => null), /measured current input drift/);
 assert.throws(() => validateInstanceAdminSuccessor(undefined, drifted, () => null), /measured current input drift/);
 assert.throws(() => validateOutboxSuccessor(undefined, drifted, () => null), /measured current input drift/);
});
test('receipt and predecessor corruption reject without host logs or Git', () => {
 for (const mutate of [value => { value.noInputDrift = false; }, value => { value.inputsAfter = {}; }, value => { value.runs[2].passed--; }, value => { value.runs[4].exitCode = 1; }, value => { value.runtimeRevision = '0'.repeat(40); }]) {
  const value = record(); mutate(value);
  assert.throws(() => validateUrlPreviewSuccessor(value, read, () => null), /receipt seal/);
 }
 for (const path of [evidencePath, predecessorPath]) assert.throws(() => readPreUrlPreview(successorFiles[0], undefined, p => p === path ? Buffer.from('{}') : read(p), () => null), /seal/);
});
test('actual logs and receipt must agree when present; missing host artifacts do not fabricate a rerun', () => {
 for (const run of record().runs) assert.throws(() => validateUrlPreviewSuccessor(record(), read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateUrlPreviewSuccessor(record(), read, p => p.endsWith('product-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
 assert.doesNotThrow(() => validateUrlPreviewSuccessor(record(), read, () => null));
});
test('a warm content cache still hashes a changed second lock read', () => {
 validateUrlPreviewSuccessor();
 let lockReads = 0;
 const changing = path => {
  const bytes = read(path);
  return path === 'pnpm-lock.yaml' && ++lockReads === 2 ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
 };
 assert.throws(() => validateUrlPreviewSuccessor(undefined, changing, () => null), /measured current input drift: pnpm-lock.yaml/);
 assert.equal(lockReads, 2);
});
test('cross-call input and receipt drift reject after warming parsed content', () => {
 let corruptedPath;
 const changing = path => path === corruptedPath ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 validateUrlPreviewSuccessor(undefined, changing, () => null);
 corruptedPath = 'packages/backend-next/package.json';
 assert.throws(() => validateUrlPreviewSuccessor(undefined, changing, () => null), /measured current input drift/);
 corruptedPath = evidencePath;
 assert.throws(() => validateUrlPreviewSuccessor(undefined, changing, () => null), /receipt seal/);
 corruptedPath = predecessorPath;
 assert.throws(() => validateUrlPreviewSuccessor(undefined, changing, () => null), /predecessor seal/);
});
test('mutating a returned historical map cannot alter later projections', () => {
 const first = validateUrlPreviewSuccessor(undefined, read, () => null);
 const expected = { ...first };
 first['pnpm-lock.yaml'] = 'forged';
 first[successorFiles[0]] = 'forged';
 first.unrelated = 'injected';
 assert.deepEqual(validateUrlPreviewSuccessor(undefined, read, () => null), expected);
});
test('repeated validations retain every actual read and optional-artifact check', () => {
 const reads = []; const artifacts = [];
 const observing = path => { reads.push(path); return read(path); };
 const optional = path => { artifacts.push(path); return null; };
 validateUrlPreviewSuccessor(undefined, observing, optional);
 const before = { reads: [...reads], artifacts: [...artifacts] };
 reads.length = 0; artifacts.length = 0;
 validateUrlPreviewSuccessor(undefined, observing, optional);
 assert.deepEqual({ reads, artifacts }, before);
 // The successor current-input gate adds lock reads; the complete-image
 // contract separately caps total live reads at 24,000.
 assert(reads.filter(path => path === 'pnpm-lock.yaml').length >= 2);
 for (const path of Object.keys(record().inputs)) assert(reads.includes(path));
 assert.equal(artifacts.filter(path => record().runs.some(run => run.log === path) || path === '/tmp/tiramiss-s1-377-20261115/product-run-receipt.json').length, record().runs.length + 1);
});
test('preview reader uses only builtins and disjoint finite successors, without subprocesses or ancestor readers', () => {
 const source = read('scripts/url-preview-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:') || match[1] === './evidence-validation-scope.mjs' || ['./meta-cache-ci-fixtures-evidence.mjs', './meta-cache-evidence.mjs', './drive-files-evidence.mjs', './url-preview-fixture-evidence.mjs', './internal-events-evidence.mjs', './drive-folders-evidence.mjs', './drive-folder-pubsub-evidence.mjs', './image-ingest-dependency-evidence.mjs', './actor-emoji-cache-evidence.mjs', './notes-pagination-evidence.mjs'].includes(match[1])));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreUrlPreview('unrelated.ts', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
