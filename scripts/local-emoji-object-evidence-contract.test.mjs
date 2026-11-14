/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readPreEmojiObject, successorFiles, validateEmojiObjectSuccessor } from './local-emoji-object-evidence.mjs';
import { readPreInstanceAdmin } from './instance-admin-evidence.mjs';
import { validateOutboxSuccessor } from './local-outbox-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-emoji-object-current-evidence.json';
const predecessorPath = directory + 'local-emoji-object-predecessor.json';
const record = () => JSON.parse(read(evidencePath));
const beforeInstanceAdmin = path => readPreInstanceAdmin(path, undefined, read, () => null);
const sha = value => createHash('sha256').update(value).digest('hex');

test('actual measured 140ac input set validates online and offline; only two historical roots are projected', () => {
 validateEmojiObjectSuccessor();
 const previous = validateEmojiObjectSuccessor(record(), read, () => null);
 assert.deepEqual(Object.keys(previous), successorFiles);
 for (const path of successorFiles) {
  assert.equal(readPreEmojiObject(path, 'utf8'), previous[path]);
  assert.notEqual(sha(read(path)), sha(Buffer.from(previous[path])));
 }
 for (const path of Object.keys(record().inputs).filter(path => !successorFiles.includes(path))) assert.deepEqual(readPreEmojiObject(path), beforeInstanceAdmin(path));
});
for (const path of Object.keys(record().inputs)) test(`new input drift rejects before projecting roots: ${path}`, () => {
 const drifted = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
 assert.throws(() => readPreEmojiObject(successorFiles[0], undefined, drifted, () => null), /(?:emoji|instance admin) measured current input drift/);
 assert.throws(() => validateOutboxSuccessor(undefined, drifted, () => null), /(?:emoji|instance admin) measured current input drift/);
});

test('receipt mutation and predecessor corruption reject without host logs', () => {
 for (const mutate of [value => { value.noInputDrift = false; }, value => { value.runs[3].passed--; }, value => { value.runs[4].exitCode = 1; }, value => { value.inputsAfter = {}; }]) {
  const value = record(); mutate(value);
  assert.throws(() => validateEmojiObjectSuccessor(value, read, () => null), /receipt seal/);
 }
 assert.throws(() => readPreEmojiObject(successorFiles[0], undefined, p => p === predecessorPath ? Buffer.from('{}') : read(p), () => null), /predecessor seal/);
 assert.throws(() => readPreEmojiObject(successorFiles[0], undefined, p => p === evidencePath ? Buffer.from('{}') : read(p), () => null), /receipt seal/);
});

test('optional available logs and actual receipt must match; explicit offline mode ignores them', () => {
 for (const run of record().runs) assert.throws(() => validateEmojiObjectSuccessor(record(), read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateEmojiObjectSuccessor(record(), read, p => p.endsWith('product-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
 assert.doesNotThrow(() => validateEmojiObjectSuccessor(record(), read, () => null));
});

test('Emoji reader imports only builtins and its finite successor, without Git or ancestor readers', () => {
 const source = read('scripts/local-emoji-object-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:') || match[1] === './instance-admin-evidence.mjs'));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreEmojiObject('unrelated.ts', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
