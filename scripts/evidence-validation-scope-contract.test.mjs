/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inEvidenceValidationScope, scopedEvidenceValidation, withEvidenceRequestedPath } from './evidence-validation-scope.mjs';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
import { validateLocalActorImagesEvidence } from './local-actor-images-evidence.mjs';
import { validateLocalActorFieldsEvidence } from './local-actor-fields-evidence.mjs';

const root = new URL('../', import.meta.url);
const identity = {};
function fixture() {
 const files = { requested: 'current', other: 'other current', 'receipt.json': '{}' };
 const artifacts = {};
 let validations = 0;
 const read = path => Buffer.from(files[path]);
 const optional = path => artifacts[path] === undefined ? null : Buffer.from(artifacts[path]);
 const validate = (reader, artifact) => {
  validations++;
  assert.equal(reader('requested').toString(), 'current');
  assert.equal(reader('other').toString(), 'other current');
  assert.equal(reader('receipt.json').toString(), '{}');
  assert.equal(artifact('log'), null);
  return { requested: 'historical' };
 };
 const project = (value = {}, reader = read, artifact = optional) => withEvidenceRequestedPath('requested', () => scopedEvidenceValidation(identity, value, reader, artifact, validate));
 return { files, artifacts, read, optional, project, validations: () => validations };
}

test('one synchronous scope validates once and rereads the requested input, metadata and optional artifacts', () => {
 const f = fixture();
 inEvidenceValidationScope(() => {
  const first = f.project(); first.requested = 'mutated result';
  assert.equal(f.project().requested, 'historical');
  assert.equal(f.validations(), 1);
  f.files.requested = 'changed';
  assert.throws(() => f.project(), /measured current input drift/);
  f.files.requested = 'current';
  f.files['receipt.json'] = 'changed receipt';
  assert.throws(() => f.project(), /measured current input drift/);
  f.files['receipt.json'] = '{}';
  f.artifacts.log = 'now present';
  assert.throws(() => f.project(), /actual log\/receipt drift/);
 });
});

test('new calls validate non-requested changes and release scope after errors', () => {
 const f = fixture();
 f.project();
 f.files.other = 'changed';
 assert.throws(() => f.project(), /other current/);
 f.files.other = 'other current';
 assert.equal(f.project().requested, 'historical');
 assert.equal(f.validations(), 3);
});

test('reader views, optional readers and changed metadata retain independent validation', () => {
 const f = fixture();
 inEvidenceValidationScope(() => {
  f.project();
  f.project({}, path => f.read(path));
  f.project({}, f.read, path => f.optional(path));
  const value = {};
  f.project(value); value.changed = true; f.project(value);
  assert.equal(f.validations(), 4);
 });
});

test('work queued during a synchronous scope starts a fresh scope', async () => {
 const f = fixture();
 let pending;
 inEvidenceValidationScope(() => {
  f.project();
  pending = Promise.resolve().then(() => assert.throws(() => f.project(), /other current/));
 });
 f.files.other = 'changed';
 await pending;
 assert.equal(f.validations(), 2);
});

test('the complete image validation stays within a bounded number of live reads', () => {
 let reads = 0;
 const raw = path => {
  // #556's sealed JSON and shared-input freshness add 8,054 necessary reads:
  // 29,493 measured, versus #555's 21,439; retain approximately 12% headroom.
  // See compatibility/avatar-images/README.md for the finite measured breakdown.
  assert(++reads <= 33000, `image validation exceeded the live read budget (${reads})`);
  return readFileSync(new URL(path, root));
 };
 const beforeAlias = path => readPreAliasKey(path, undefined, raw);
 const value = JSON.parse(beforeAlias('docs/superpowers/compatibility/remote-user/local-actor-images-current-evidence.json'));
 validateLocalActorImagesEvidence(value, beforeAlias, () => null);
});

test('a repeated predecessor read cannot replace the first pinned digest', () => {
 const beforeAlias = path => readPreAliasKey(path);
 const value = JSON.parse(beforeAlias('docs/superpowers/compatibility/remote-user/local-actor-fields-current-evidence.json'));
 let predecessorReads = 0;
 const changing = path => {
  const bytes = beforeAlias(path);
  return path === value.predecessor.path && ++predecessorReads > 1 ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
 };
 assert.throws(() => validateLocalActorFieldsEvidence(value, changing, () => null), /measured current input drift/);
 assert.equal(predecessorReads, 2);
});

test('repeated optional reads cannot replace the first presence or digest', () => {
 for (const initial of [null, Buffer.from('pinned receipt')]) {
  let reads = 0;
  const changing = () => ++reads === 1 ? initial : Buffer.from('changed receipt');
  const validate = (_read, optional) => {
   assert.deepEqual(optional('receipt'), initial);
   optional('receipt');
   return { requested: 'historical' };
  };
  assert.throws(() => scopedEvidenceValidation(identity, {}, () => Buffer.from('current'), changing, validate), /actual log\/receipt drift/);
 }
});
