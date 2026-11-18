/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';
import { pubsubSuccessorFiles, readPreDriveFolderPubsub, validateDriveFolderPubsubSuccessor, projectComparisonCiWorkflow } from './drive-folder-pubsub-evidence.mjs';
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
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:') || match[1] === './evidence-validation-scope.mjs' || match[1] === './meta-cache-evidence.mjs' || match[1] === './drive-files-evidence.mjs' || match[1] === './drive-folder-observation-evidence.mjs' || match[1] === './announcement-archive-predecessor.mjs'));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreDriveFolderPubsub('unrelated', 'utf8', () => Buffer.from('live'), () => null), 'live');
});

test('notes CI paths, process Redis and video runner setup preserve exact historical workflows and reject old bytes as current', () => {
 const path = '.github/workflows/test-backend-next.yml';
 const addition = '      - name: Install FFmpeg\n        run: |\n          sudo apt update\n          sudo apt install -y ffmpeg\n';
 const service = '      redis-pubsub:\n        image: redis:8\n        ports: [\'56380:6379\']\n        options: >-\n          --health-cmd "redis-cli ping"\n          --health-interval 1s --health-timeout 3s --health-retries 30\n';
 const current = projectComparisonCiWorkflow(read(path)).toString();
 const notesPath = "      - 'docs/superpowers/compatibility/notes-pagination/**'\n";
 assert.equal(current.split(notesPath).length, 3, 'notes documents trigger push and pull request');
 const beforeNotes = Buffer.from(current.replaceAll(notesPath, ''));
 assert.equal(sha(beforeNotes), '522b45f35703a65febb1d1471e601a74914570b364a2e0f205ddb9e895702178');
 assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, file => file === path ? beforeNotes : read(file), () => null), /measured current input drift/);
 const sections = beforeNotes.toString().split('  process:\n');
 assert.equal(sections.length, 2);
 assert.equal(sections[0].split(service).length, 2, 'integration service stays present');
 assert.equal(sections[1].split(service).length, 2, 'process has one dedicated service');
 const beforeRedis = Buffer.from(sections[0] + '  process:\n' + sections[1].replace(service, ''));
 assert.equal(sha(beforeRedis), '41bf145751d3c3b6825e54abb9018e7dc706e0d757d08c6f2568ee3a8bd26184');
 const before = Buffer.from(beforeRedis.toString().replace(addition, ''));
 assert.equal(sha(before), record().inputs[path]);
 assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, file => file === path ? beforeRedis : read(file), () => null), /measured current input drift/);
 assert.doesNotThrow(() => validateDriveFolderPubsubSuccessor(undefined, read, () => null));
 assert.throws(() => validateDriveFolderPubsubSuccessor(undefined, file => file === path ? before : read(file), () => null), /measured current input drift/);
});
test('current process Redis workflow drift rejects after warming its requested path within one validation scope', () => {
 const path = '.github/workflows/test-backend-next.yml';
 let changed = false;
 const reader = file => changed && file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 const offline = () => null;
 inEvidenceValidationScope(() => {
  readPreDriveFolderPubsub(path, undefined, reader, offline);
  changed = true;
  assert.throws(() => readPreDriveFolderPubsub(path, undefined, reader, offline), /measured current input drift/);
 });
});
