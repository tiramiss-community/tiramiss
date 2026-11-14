/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import { readPreOutbox, successorFiles, validateOutboxSuccessor } from './local-outbox-evidence.mjs';
import { readPreAliasKey, validateAliasKeySuccessor } from './local-actor-alias-key-evidence.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const directory = 'docs/superpowers/compatibility/remote-user/';
const evidencePath = directory + 'local-outbox-current-evidence.json';
const predecessorPath = directory + 'local-outbox-predecessor.json';
const record = () => JSON.parse(read(evidencePath));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual 1e75 receipt validates online and without ephemeral host logs', () => {
 validateOutboxSuccessor();
 validateOutboxSuccessor(record(), read, () => null);
 const previous = JSON.parse(read(predecessorPath));
 assert.equal(previous.commit, record().baseRevision);
 assert.deepEqual(Object.keys(previous.files), successorFiles);
 for (const path of successorFiles) {
  assert.equal(readPreOutbox(path, 'utf8'), previous.files[path]);
  assert.notEqual(sha(readPreOutbox(path)), record().inputs[path]);
 }
});

for (const path of Object.keys(record().inputs)) test(`reject current input drift before projection: ${path}`, () => {
 const drifted = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
 assert.throws(() => validateOutboxSuccessor(record(), drifted, () => null), /measured current input drift/);
 assert.throws(() => readPreOutbox(successorFiles[0], undefined, drifted), /measured current input drift/);
 assert.throws(() => readPreAliasKey(successorFiles[0], undefined, drifted), /measured current input drift/);
});

for (const [name, mutate] of [
 ['forged input', v => { v.inputs[successorFiles[0]] = '0'.repeat(64); }],
 ['missing suite', v => { v.runs.splice(2, 1); }],
 ['failed suite', v => { v.runs[2].exitCode = 1; }],
 ['skipped suite', v => { v.runs[2].skipped = 1; }],
 ['incomplete count', v => { v.runs[2].passed--; }],
 ['forged file count', v => { v.runs[3].files--; }],
 ['source count', v => { v.runs[4].sourceCases--; }],
 ['contract count', v => { v.runs[5].nodeTests--; }],
 ['forged log hash', v => { v.runs[0].logSha256 = '0'.repeat(64); }],
 ['missing after input', v => { delete v.inputsAfter[successorFiles[0]]; }],
 ['false no-drift claim', v => { v.noInputDrift = false; }],
 ['invented current input', v => { v.inputs['arbitrary.ts'] = '0'.repeat(64); }],
]) test(`sealed receipt rejects ${name} offline`, () => {
 const value = record(); mutate(value);
 assert.throws(() => validateOutboxSuccessor(value, read, () => null), /receipt seal/);
});

test('both static seals reject corruption and additional predecessors', () => {
 for (const path of [evidencePath, predecessorPath]) {
  assert.throws(() => readPreOutbox(successorFiles[0], undefined, p => p === path ? Buffer.from('{}') : read(p)), /seal/);
 }
 const previous = JSON.parse(read(predecessorPath));
 previous.files['arbitrary.ts'] = 'unmeasured';
 assert.throws(() => validateOutboxSuccessor(record(), p => p === predecessorPath ? Buffer.from(JSON.stringify(previous)) : read(p), () => null), /predecessor seal/);
});

test('each actual raw log and original host receipt must agree when available', () => {
 for (const run of record().runs) {
  assert.throws(() => validateOutboxSuccessor(record(), read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 }
 const path = '/tmp/tiramiss-s1-324-20261114/product-run-receipt.json';
 assert.throws(() => validateOutboxSuccessor(record(), read, p => p === path ? Buffer.from('{}') : null), /actual receipt drift/);
});

test('outside six is exact passthrough, including corpora, receipts and new files', () => {
 for (const path of Object.keys(record().inputs).filter(p => !successorFiles.includes(p))) {
  assert.deepEqual(readPreOutbox(path), read(path));
 }
 assert.equal(readPreOutbox('arbitrary.ts', 'utf8', () => Buffer.from('live')), 'live');
});

test('323 validates original current inputs after finite projection with explicit readers', () => {
 const alias = JSON.parse(read(directory + 'local-actor-alias-key-current-evidence.json'));
 validateAliasKeySuccessor(alias, read, () => null);
 for (const [path, digest] of Object.entries(alias.receipt.sourceInputs)) assert.equal(sha(readPreOutbox(path)), digest);
 assert.notEqual(sha(readPreAliasKey('packages/backend-next/src/modules/federation/public.ts')), sha(readPreOutbox('packages/backend-next/src/modules/federation/public.ts')));
 const old = directory + 'local-actor-alias-key-predecessor.json';
 assert.throws(() => readPreAliasKey('packages/backend-next/src/modules/federation/public.ts', undefined, p => p === old ? Buffer.from('{}') : read(p)), /alias-key historical fixture drift/);
});

test('explicit offline readers ignore residual host files while default readers reject them', () => {
 const alias = JSON.parse(read(directory + 'local-actor-alias-key-current-evidence.json'));
 const originalRead = fs.readFileSync;
 const patched = mock.method(fs, 'readFileSync', (path, ...args) => {
  if (typeof path === 'string' && path.startsWith('/tmp/tiramiss-s1-324-20261114/')) {
   return Buffer.from('stale host artifact');
  }
  return originalRead(path, ...args);
 });
 syncBuiltinESMExports();
 try {
  assert.doesNotThrow(() => validateAliasKeySuccessor(alias, read, () => null));
  assert.doesNotThrow(() => readPreOutbox(successorFiles[0], undefined, read, () => null));
  assert.throws(() => validateAliasKeySuccessor(alias, read), /outbox actual (log|receipt) drift/);
  assert.throws(() => readPreOutbox(successorFiles[0], undefined, read), /outbox actual (log|receipt) drift/);
 } finally {
  patched.mock.restore();
  syncBuiltinESMExports();
 }
});

test('leaf imports only Node builtins and performs no subprocess or dynamic imports', () => {
 const source = read('scripts/local-outbox-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(m => m[1].startsWith('node:')));
 assert(!/execFile|spawn|import\(/.test(source));
});
