/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readPreInstanceAdmin, successorFiles, validateInstanceAdminSuccessor } from './instance-admin-evidence.mjs';
import { readPreEmojiObject, validateEmojiObjectSuccessor } from './local-emoji-object-evidence.mjs';
import { readPreHashtagOracle, validateHashtagOracleSuccessor } from './hashtag-oracle-evidence.mjs';
import { readPreOutbox, validateOutboxSuccessor } from './local-outbox-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'instance-admin-current-evidence.json';
const predecessorPath = directory + 'instance-admin-predecessor.json';
const record = () => JSON.parse(read(evidencePath));

test('actual merged product receipt validates online/offline and projects exactly nine frozen inputs', () => {
 validateInstanceAdminSuccessor();
 const previous = validateInstanceAdminSuccessor(record(), read, () => null);
 assert.deepEqual(Object.keys(previous), successorFiles);
 for (const path of successorFiles) {
  assert.equal(readPreInstanceAdmin(path, 'utf8'), previous[path]);
  assert.notEqual(sha(read(path)), sha(Buffer.from(previous[path])));
 }
 for (const path of Object.keys(record().inputs).filter(path => !successorFiles.includes(path))) assert.deepEqual(readPreInstanceAdmin(path), read(path));
});
for (const path of Object.keys(record().inputs)) test(`instance admin rejects current measured input drift: ${path}`, () => {
 const drifted = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
 assert.throws(() => validateInstanceAdminSuccessor(record(), drifted, () => null), /measured current input drift/);
 assert.throws(() => validateEmojiObjectSuccessor(undefined, drifted, () => null), /measured current input drift/);
 assert.throws(() => readPreOutbox(successorFiles[0], undefined, drifted, () => null), /measured current input drift/);
});

test('both receipt/predecessor seals reject corruption without relying on host logs', () => {
 for (const mutate of [v => { v.noInputDrift = false; }, v => { v.inputsAfter = {}; }, v => { v.runs[2].passed--; }, v => { v.runs[3].exitCode = 1; }, v => { v.runtimeRevision = '0'.repeat(40); }]) {
  const value = record(); mutate(value);
  assert.throws(() => validateInstanceAdminSuccessor(value, read, () => null), /receipt seal/);
 }
 for (const corrupt of [evidencePath, predecessorPath]) assert.throws(() => readPreInstanceAdmin(successorFiles[0], undefined, p => p === corrupt ? Buffer.from('{}') : read(p), () => null), /seal/);
});

test('available actual logs and receipt must agree; explicit offline mode ignores ephemeral files', () => {
 for (const run of record().runs) assert.throws(() => validateInstanceAdminSuccessor(record(), read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateInstanceAdminSuccessor(record(), read, p => p.endsWith('product-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
 assert.doesNotThrow(() => validateInstanceAdminSuccessor(record(), read, () => null));
});

test('unchanged Emoji receipt still validates all fourteen original measured inputs before outbox projection', () => {
 const emoji = JSON.parse(read(directory + 'local-emoji-object-current-evidence.json'));
 const changed = [];
 for (const [path, digest] of Object.entries(emoji.inputs)) {
  assert.equal(sha(readPreInstanceAdmin(path)), digest);
  if (sha(read(path)) !== digest) changed.push(path);
 }
 assert.deepEqual(changed, ['packages/backend-next/src/composition/http-app.ts', 'packages/backend-next/src/modules/federation/public.ts', 'packages/backend-next/test/unit/composition/http-app.test.ts']);
 validateEmojiObjectSuccessor(emoji, read, () => null);
 validateOutboxSuccessor(undefined, read, () => null);
});

test('leaf reader imports only Node builtins, passes outside paths through and launches no subprocess/ancestor', () => {
 const source = read('scripts/instance-admin-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(m => m[1].startsWith('node:')));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreInstanceAdmin('unrelated.ts', 'utf8', () => Buffer.from('live'), () => null), 'live');
});

test('hashtag oracle renewal is disjoint and cannot mask the sixteen instance-admin inputs', () => {
 const oracle = JSON.parse(read('docs/superpowers/compatibility/note/hashtag/oracle-schedule-evidence.json'));
 const oraclePaths = Object.keys(oracle.inputs);
 assert.equal(oraclePaths.length, 4);
 assert.deepEqual(oraclePaths.filter(path => path in record().inputs || successorFiles.includes(path)), []);
 for (const path of Object.keys(record().inputs)) assert.deepEqual(readPreHashtagOracle(path), read(path));
 for (const path of oraclePaths) assert.deepEqual(readPreInstanceAdmin(path), read(path));
 const previous = validateHashtagOracleSuccessor(oracle, read, () => null);
 const path = 'packages/backend-next/test/integration/note-hashtags.test.ts';
 assert.equal(readPreEmojiObject(path, 'utf8'), previous[path]);
 assert.notEqual(sha(readPreEmojiObject(path)), oracle.inputs[path]);
 validateInstanceAdminSuccessor(record(), read, () => null);
});
