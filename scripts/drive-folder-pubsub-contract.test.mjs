/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { pubsubSuccessorFiles, readPreDriveFolderPubsub, validateDriveFolderPubsubSuccessor } from './drive-folder-pubsub-evidence.mjs';
import { validateDriveFoldersSuccessor } from './drive-folders-evidence.mjs';
import { readPreUrlPreview } from './url-preview-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/drive-folders/';
const read = path => readFileSync(new URL(path, root));
const record = () => JSON.parse(read(directory + 'pubsub-fix-evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('new measured pubsub product and process lane validate online/offline while the initial receipt remains historical', () => {
 const offline = validateDriveFolderPubsubSuccessor(record(), read, () => null);
 assert.deepEqual(validateDriveFolderPubsubSuccessor(), offline);
 assert.deepEqual(Object.keys(offline), pubsubSuccessorFiles);
 for (const path of pubsubSuccessorFiles) {
  assert.equal(readPreDriveFolderPubsub(path, 'utf8'), offline[path]);
  assert.equal(readPreUrlPreview(path, 'utf8'), offline[path]);
  assert.notEqual(sha(read(path)), sha(Buffer.from(offline[path])));
 }
 assert.equal(record().runs.find(run => run.name === 'integration').passed, 70);
 assert.equal(record().runs.find(run => run.name === 'process').passed, 2);
 assert.doesNotThrow(() => validateDriveFoldersSuccessor(undefined, read, () => null));
});
for (const path of Object.keys(record().inputs)) test(`new pubsub measured input cannot drift through initial evidence: ${path}`, () => {
 const drifted = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 assert.throws(() => validateDriveFolderPubsubSuccessor(record(), drifted, () => null), /measured current input drift/);
 assert.throws(() => validateDriveFoldersSuccessor(undefined, drifted, () => null), /measured current input drift/);
});
test('both immutable receipts, predecessor and optional artifacts reject forgery without source/Git access', () => {
 const forged = record(); forged.runtimeRevision = '0'.repeat(40);
 assert.throws(() => validateDriveFolderPubsubSuccessor(forged, read, () => null), /receipt seal/);
 for (const file of ['pubsub-fix-evidence.json', 'pubsub-fix-predecessor.json', 'current-evidence.json']) assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, path => path === directory + file ? Buffer.from('{}') : read(path), () => null), /seal|published receipt drift/);
 for (const run of record().runs) assert.throws(() => validateDriveFolderPubsubSuccessor(record(), read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateDriveFolderPubsubSuccessor(record(), read, path => path.endsWith('pubsub-product-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
});
test('finite pubsub reader uses builtins and its observation successor and passes unrelated input bytes through', () => {
 const source = read('scripts/drive-folder-pubsub-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:') || match[1] === './drive-files-evidence.mjs' || match[1] === './drive-folder-observation-evidence.mjs'));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreDriveFolderPubsub('unrelated', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
