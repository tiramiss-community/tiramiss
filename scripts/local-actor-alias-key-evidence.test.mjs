/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readPreAliasKey, validateAliasKeySuccessor, successorFiles } from './local-actor-alias-key-evidence.mjs';
import { readPreOutbox } from './local-outbox-evidence.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const path = 'docs/superpowers/compatibility/remote-user/local-actor-alias-key-current-evidence.json';
const record = () => JSON.parse(read(path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('sealed six-consumer successor validates actual 43e measurements with and without host files', () => {
 validateAliasKeySuccessor();
 validateAliasKeySuccessor(record(), read, () => null);
 for (const file of successorFiles) {
  assert.equal(sha(readPreAliasKey(file)), record().files[file].previousSha256);
  assert.equal(sha(readPreOutbox(file)), record().files[file].sha256);
 }
});

test('all six live source/test drifts reject before historical projection', () => {
 for (const file of successorFiles) {
  assert.throws(() => readPreAliasKey(file, undefined, p => p === file ? Buffer.concat([read(p), Buffer.from(' ')]) : read(p)), /current source\/test drift|measured current input drift/);
 }
});

test('every current measurement input including new tests and corpus is still checked', () => {
 for (const file of Object.keys(record().receipt.sourceInputs)) {
  assert.throws(() => validateAliasKeySuccessor(record(), p => p === file ? Buffer.from('corrupt') : read(p), () => null), /measured current input drift/);
 }
});

test('historical fixture corruption fails and unrelated live reads are not projected', () => {
 const fixture = 'docs/superpowers/compatibility/remote-user/local-actor-alias-key-predecessor.json';
 assert.throws(() => readPreAliasKey(successorFiles[0], undefined, p => p === fixture ? Buffer.from('{}') : read(p)), /historical fixture drift/);
 const outside = 'packages/backend-next/src/modules/federation/local-follow-collections.ts';
 assert.equal(readPreAliasKey(outside, 'utf8', () => Buffer.from('changed')), 'changed');
});

for (const [name, mutate] of [
 ['false receipt', v => { v.receipt.runs['db-http'].exitCode = 1; }],
 ['missing applicable suite', v => { delete v.receipt.runs.units; }],
 ['skip or incomplete count', v => { v.receipt.runs.units.tests--; }],
 ['unmeasured current hash', v => { v.files[successorFiles[0]].sha256 = '0'.repeat(64); }],
 ['invented predecessor for new file', v => { v.files['packages/backend-next/src/modules/federation/acct.ts'] = v.files[successorFiles[0]]; }],
 ['historical digest', v => { v.files[successorFiles[0]].previousSha256 = '0'.repeat(64); }],
]) test(`sealed successor rejects ${name} offline`, () => {
 const value = record(); mutate(value);
 assert.throws(() => validateAliasKeySuccessor(value, read, () => null), /successor record seal/);
});

test('optional actual logs and receipt cannot disagree with saved measurements', () => {
 const value = record();
 for (const file of [...Object.values(value.receipt.runs).map(r => r.commandLog), value.regression.commandLog, '/tmp/tiramiss-s1-323-20261114/runtime-receipt.json', '/tmp/tiramiss-s1-323-20261114/regression-receipt.json']) {
  assert.throws(() => validateAliasKeySuccessor(value, read, p => p === file ? Buffer.from('{}') : null), /actual .*drift/);
 }
});

test('successor reader has no ancestor helpers or subprocess fallback', () => {
 const source = read('scripts/local-actor-alias-key-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(m => m[1].startsWith('node:') || m[1] === './local-outbox-evidence.mjs'));
 assert(!/execFile|spawn|import\(/.test(source));
});
