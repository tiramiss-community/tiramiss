/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { successorFiles, validateDriveFoldersSuccessor } from './drive-folders-evidence.mjs';
import { validateUrlPreviewSuccessor } from './url-preview-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/drive-folders/';
const read = path => readFileSync(new URL(path, root));
const json = path => JSON.parse(read(directory + path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = () => json('current-evidence.json');
test('exact measured folder product validates with and without available logs and restores only two old composition inputs', () => {
 const actual = validateDriveFoldersSuccessor();
 const offline = validateDriveFoldersSuccessor(record(), read, () => null);
 assert.deepEqual(actual, offline);
 assert.deepEqual(Object.keys(actual), successorFiles);
 assert.equal(record().runs.find(run => run.name === 'near-unit').passed, 78);
 assert.equal(record().runs.find(run => run.name === 'integration').passed, 68);
 validateUrlPreviewSuccessor(undefined, read, () => null);
});
for (const path of Object.keys(record().inputs)) test(`folder current product input cannot drift before old projection: ${path}`, () => {
 const drift = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 assert.throws(() => validateDriveFoldersSuccessor(record(), drift, () => null), /measured current input drift/);
 assert.throws(() => validateUrlPreviewSuccessor(undefined, drift, () => null), /measured current input drift/);
});
test('current receipt, predecessor and optional log/receipt corruption fail without Git', () => {
 const value = record(); value.runtimeRevision = '0'.repeat(40);
 assert.throws(() => validateDriveFoldersSuccessor(value, read, () => null), /receipt seal/);
 for (const file of ['current-evidence.json', 'predecessor.json']) assert.throws(() => validateDriveFoldersSuccessor(undefined, path => path === directory + file ? Buffer.from('{}') : read(path), () => null), /seal/);
 for (const run of record().runs) assert.throws(() => validateDriveFoldersSuccessor(record(), read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateDriveFoldersSuccessor(record(), read, path => path.endsWith('product-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
});
test('source observations bind the exact corpus, fixed source files and literal gate precedence', () => {
 const observation = json('observations.json');
 assert.equal(observation.upstreamCommit, record().upstreamRevision);
 assert.equal(observation.corpusSha256, sha(read(directory + 'corpus.json')));
 assert.equal(observation.cases.length, 57);
 assert.equal(observation.manifest.length, 11);
 assert.equal(new Set(observation.manifest.map(row => row.path)).size, 11);
 for (const row of observation.manifest) {
  assert.match(row.gitBlob, /^[a-f0-9]{40}$/);
  assert.match(row.sha256, /^[a-f0-9]{64}$/);
 }
 assert.deepEqual(observation.gateCases.map(row => [row.id, row.error]), [
  ['scope-before-input', 'PERMISSION_DENIED'], ['suspended-before-scope', 'YOUR_ACCOUNT_SUSPENDED'],
  ['quota-before-suspended-and-scope', 'RATE_LIMIT_EXCEEDED'], ['redis-before-suspended-and-scope', 'Redis unavailable'], ['factor-zero', undefined],
 ]);
});
test('finite folder reader uses builtins and its narrow pubsub successor only and cannot spawn source/Git subprocesses', () => {
 const source = read('scripts/drive-folders-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:') || match[1] === './id-codec-predecessor.mjs' || match[1] === './evidence-validation-scope.mjs' || match[1] === './meta-cache-evidence.mjs' || match[1] === './drive-files-evidence.mjs' || match[1] === './drive-folder-pubsub-evidence.mjs'));
 assert(!/execFile|spawn|import\(/.test(source));
});
