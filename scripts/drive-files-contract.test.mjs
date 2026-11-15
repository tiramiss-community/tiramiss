/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readForDriveFileEvidence } from './joint-drive-meta-evidence.mjs';
import { driveFilePredecessorFiles, readPreDriveFiles } from './drive-files-evidence.mjs';
import { validateDriveFolderPubsubSuccessor } from './drive-folder-pubsub-evidence.mjs';
import { validateDriveFoldersSuccessor } from './drive-folders-evidence.mjs';
import { readPreUrlPreview } from './url-preview-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/drive-files/';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('source observations bind the fixed upstream blobs and finite corpus to unit and actual HTTP tests', () => {
 const corpus = JSON.parse(read(directory + 'corpus.json'));
 const source = JSON.parse(read(directory + 'observations.json'));
 assert.equal(source.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
 assert.equal(source.upstreamCommit, corpus.upstreamCommit);
 assert.equal(source.corpusSha256, sha(read(directory + 'corpus.json')));
 assert.deepEqual(source.cases.map(c => c.id), corpus.cases.map(c => c.id));
 assert.deepEqual(source.packing.map(c => c.id), corpus.packing.map(c => c.id));
 assert.deepEqual(source.names.map(c => c.name), corpus.names);
 assert.equal(source.cases.length, 71); assert.equal(source.packing.length, 52); assert.equal(source.names.length, 12);
 assert.equal(new Set(source.manifest.map(m => m.path)).size, source.manifest.length);
 for (const item of source.manifest) { assert.match(item.sha256, /^[a-f0-9]{64}$/); assert.match(item.gitBlob, /^[a-f0-9]{40}$/); }
 for (const path of ['packages/backend-next/test/unit/drive/files-source.test.ts', 'packages/backend-next/test/integration/drive-files-source-http.test.ts']) {
  const test = read(path).toString(); assert(test.includes('corpus.cases')); assert(test.includes('source.cases.find'));
 }
});
test('bounded file-read transition preserves three exact historical inputs without claiming old measurements were rerun', () => {
 const saved = JSON.parse(read(directory + 'predecessor.json'));
 assert.deepEqual(Object.keys(saved.files), driveFilePredecessorFiles);
 for (const path of driveFilePredecessorFiles) {
  assert.equal(readPreDriveFiles(path, 'utf8'), saved.files[path]);
  assert.equal(sha(readForDriveFileEvidence(path, read)), saved.currentInputs[path]);
  assert.notEqual(sha(Buffer.from(saved.files[path])), saved.currentInputs[path]);
 }
 assert.doesNotThrow(() => validateDriveFolderPubsubSuccessor(undefined, read, () => null));
 assert.doesNotThrow(() => validateDriveFoldersSuccessor(undefined, read, () => null));
 assert.equal(readPreUrlPreview(driveFilePredecessorFiles[2], 'utf8'), saved.files[driveFilePredecessorFiles[2]]);
});
for (const path of driveFilePredecessorFiles) test(`file-read transition rejects current byte drift: ${path}`, () => {
 const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 assert.throws(() => readPreDriveFiles(path, undefined, changed), /measured current input drift/);
 assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, changed, () => null), /measured current input drift/);
 assert.throws(() => validateDriveFoldersSuccessor(undefined, changed, () => null), /measured current input drift/);
});
test('file transition rejects forged preimages and every fresh second read; unrelated paths pass through', () => {
 const path = driveFilePredecessorFiles[0];
 assert.throws(() => readPreDriveFiles(path, undefined, file => file === directory + 'predecessor.json' ? Buffer.from('{}') : read(file)), /predecessor seal/);
 let changed = false;
 const changing = file => file === path && changed ? Buffer.from('forged') : read(file);
 readPreDriveFiles(path, undefined, changing); changed = true;
 assert.throws(() => readPreDriveFiles(path, undefined, changing), /measured current input drift/);
 assert.equal(readPreDriveFiles('unrelated', 'utf8', () => Buffer.from('live')), 'live');
 const source = read('scripts/drive-files-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => (match[1].startsWith('node:') || match[1] === './joint-drive-meta-evidence.mjs')));
 assert(!/execFile|spawn|import\(/.test(source));
});
