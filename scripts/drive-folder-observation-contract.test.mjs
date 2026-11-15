/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { folderObservationPath, readPreFolderObservation, validateFolderObservation } from './drive-folder-observation-evidence.mjs';
import { validateDriveFolderPubsubSuccessor } from './drive-folder-pubsub-evidence.mjs';
import { validateDriveFoldersSuccessor } from './drive-folders-evidence.mjs';
import { readPreUrlPreview } from './url-preview-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/drive-folders/';
const evidencePath = directory + 'observation-sync-evidence.json';
const predecessorPath = directory + 'observation-sync-predecessor.json';
const record = () => JSON.parse(read(evidencePath));
test('one measured observation fixture projects its prior bytes and preserves both product receipts', () => {
 const previous = validateFolderObservation(undefined, read, () => null);
 assert.deepEqual(validateFolderObservation(), previous);
 assert.deepEqual(Object.keys(previous), [folderObservationPath]);
 assert.equal(readPreFolderObservation(folderObservationPath, 'utf8'), previous[folderObservationPath]);
 const pubsub = validateDriveFolderPubsubSuccessor(undefined, read, () => null);
 assert.equal(readPreUrlPreview(folderObservationPath, 'utf8'), pubsub[folderObservationPath]);
 assert.doesNotThrow(() => validateDriveFoldersSuccessor(undefined, read, () => null));
 assert.equal(sha(read(directory + 'current-evidence.json')), '25495f4f75b1b073844b395b067f74589f882e9595838ee26c01f28121caa953');
 assert.equal(sha(read(directory + 'pubsub-fix-evidence.json')), '82403ca1f6ea5a54eb1a31cca8736dcf03fecd62c89ea614180abdf3a5d85c3d');
});
test('current fixture drift rejects directly and through every product history reader', () => {
 const changed = path => path === folderObservationPath ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 assert.throws(() => validateFolderObservation(undefined, changed, () => null), /measured current input drift/);
 assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, changed, () => null), /measured current input drift/);
 assert.throws(() => validateDriveFoldersSuccessor(undefined, changed, () => null), /measured current input drift/);
 assert.throws(() => readPreUrlPreview(folderObservationPath, undefined, changed, () => null), /measured current input drift/);
});
test('receipt/predecessor corruption and failed or incomplete measurements reject offline', () => {
 for (const file of [evidencePath, predecessorPath]) {
  const changed = path => path === file ? Buffer.from('{}') : read(path);
  assert.throws(() => validateFolderObservation(undefined, changed, () => null), /seal/);
  assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, changed, () => null), /seal/);
 }
 for (const mutate of [v => { v.run.exitCode = 1; }, v => { v.run.passed--; }, v => { v.inputsAfter = {}; }, v => { v.fixtureRevision = '0'.repeat(40); }, v => { v.noInputDrift = false; }]) {
  const value = record(); mutate(value);
  assert.throws(() => validateFolderObservation(value, read, () => null), /receipt seal/);
 }
});
test('available run, counterexample and raw receipt reject forgery; offline validation stays strict', () => {
 assert.throws(() => validateFolderObservation(undefined, read, path => path === record().run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateFolderObservation(undefined, read, path => path === record().controlledCounterexample.log ? Buffer.from('forged RED') : null), /actual counterexample drift/);
 assert.throws(() => validateFolderObservation(undefined, read, path => path.endsWith('fixture-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
 assert.doesNotThrow(() => validateFolderObservation(undefined, read, () => null));
});
test('a returned prior map cannot affect later reads or admit a changed second fixture', () => {
 const previous = validateFolderObservation(undefined, read, () => null);
 previous[folderObservationPath] = 'forged';
 previous.unrelated = 'forged';
 assert.notEqual(validateFolderObservation(undefined, read, () => null)[folderObservationPath], 'forged');
 let changed = false;
 const changing = path => path === folderObservationPath && changed ? Buffer.from('forged') : read(path);
 validateFolderObservation(undefined, changing, () => null);
 changed = true;
 assert.throws(() => validateFolderObservation(undefined, changing, () => null), /measured current input drift/);
});
test('finite observation reader uses builtins only and passes unrelated bytes through', () => {
 const source = read('scripts/drive-folder-observation-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:')));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreFolderObservation('unrelated', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
