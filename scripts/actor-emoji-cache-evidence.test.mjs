/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { actorEmojiCacheFiles, readForActorEmojiCacheEvidence, validateActorEmojiCacheEvidence, actorEmojiBatchFiles, validateActorEmojiBatchEvidence } from './actor-emoji-cache-evidence.mjs';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/actor-emoji-cache/';
const record = () => JSON.parse(read(directory + 'current-evidence.json'));
test('actor cache preserves exact finite predecessors and passes unrelated dependency bytes through', () => {
 const before = validateActorEmojiCacheEvidence(undefined, read, () => null);
 assert.deepEqual(Object.keys(before), actorEmojiCacheFiles);
 for (const path of actorEmojiCacheFiles) assert.equal(readForActorEmojiCacheEvidence(path, read, () => null).toString(), before[path]);
 for (const path of ['packages/backend-next/package.json', 'pnpm-lock.yaml', 'unrelated']) assert.equal(readForActorEmojiCacheEvidence(path, () => Buffer.from('independent')).toString(), 'independent');
});
for (const path of Object.keys(record().inputs)) {
 test(`actor cache rejects current drift ${path}`, () => {
  const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
  assert.throws(() => validateActorEmojiCacheEvidence(undefined, changed, () => null), /measured current input drift/);
 });
}
test('actor cache rejects a historical view as current, receipt corruption and forged successful logs', () => {
 const before = validateActorEmojiCacheEvidence(undefined, read, () => null);
 const projected = path => Object.hasOwn(before, path) ? Buffer.from(before[path]) : read(path);
 assert.throws(() => validateActorEmojiCacheEvidence(undefined, projected, () => null), /measured current input drift/);
 for (const suffix of ['current-evidence.json', 'predecessor.json']) assert.throws(() => validateActorEmojiCacheEvidence(undefined, path => path === directory + suffix ? Buffer.from('{}') : read(path), () => null), /seal/);
 for (const run of record().runs) assert.throws(() => validateActorEmojiCacheEvidence(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
});
test('actor validation preserves fresh calls, same-scope requested drift and independent reader identities', () => {
 const requested = actorEmojiCacheFiles[0]; let changed;
 const dynamic = path => path === changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 const optional = () => null;
 inEvidenceValidationScope(() => {
  readForActorEmojiCacheEvidence(requested, dynamic, optional); changed = requested;
  assert.throws(() => readForActorEmojiCacheEvidence(requested, dynamic, optional), /measured current input drift/);
  assert(Buffer.isBuffer(readForActorEmojiCacheEvidence(requested, read, optional)));
 });
 assert.throws(() => readForActorEmojiCacheEvidence(requested, dynamic, optional), /measured current input drift/);
 changed = undefined;
 const mutable = readForActorEmojiCacheEvidence(requested, dynamic, optional); mutable[0] = 0;
 assert.notEqual(readForActorEmojiCacheEvidence(requested, dynamic, optional)[0], 0);
});


test('batch follow-up restores exactly three inputs and rejects current drift, historical views and corrupt records', () => {
 const value = JSON.parse(read(directory + 'batch-current-evidence.json'));
 const before = validateActorEmojiBatchEvidence(undefined, read, () => null);
 assert.deepEqual(Object.keys(before), actorEmojiBatchFiles);
 for (const path of Object.keys(value.inputs)) {
  const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
  assert.throws(() => validateActorEmojiBatchEvidence(undefined, changed, () => null), /measured current input drift/);
  assert.throws(() => validateActorEmojiCacheEvidence(undefined, changed, () => null), /measured current input drift/);
 }
 const projected = path => Object.hasOwn(before, path) ? Buffer.from(before[path]) : read(path);
 assert.throws(() => validateActorEmojiBatchEvidence(undefined, projected, () => null), /measured current input drift/);
 for (const name of ['batch-current-evidence.json', 'batch-predecessor.json']) assert.throws(() => validateActorEmojiBatchEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), () => null), /seal/);
 for (const run of [...value.runs, value.regression.red, value.regression.green]) assert.throws(() => validateActorEmojiBatchEvidence(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
});

test('batch follow-up retains fresh validation and the original receipt remains immutable', () => {
 const path = actorEmojiBatchFiles[0]; let changed = false;
 const dynamic = file => file === path && changed ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 const optional = () => null;
 validateActorEmojiBatchEvidence(undefined, dynamic, optional); changed = true;
 assert.throws(() => validateActorEmojiBatchEvidence(undefined, dynamic, optional), /measured current input drift/);
 assert.equal(record().baseRevision, '5f0549ad96af7ce85e12fdcc4bf26f23b029d29d');
 assert.equal(Object.keys(record().inputs).length, 18);
});

test('stream auth metadata preserves actor receipt without accepting the previous adapter as current input', () => {
 const path = 'packages/backend-next/src/platform/database/streaming.ts';
 const current = read(path).toString();
 const previous = current.replace('\t\t\t\ttokenPermissions: caller.credential.native ? undefined : [...caller.credential.permissions],\n', '');
 assert.notEqual(previous, current);
 assert.equal(Object.keys(validateActorEmojiCacheEvidence(undefined, read, () => null)).length, 12);
 assert.throws(() => validateActorEmojiCacheEvidence(undefined, file => file === path ? Buffer.from(previous) : read(file), () => null), /measured current input drift/);
 // The reader's authorization field alone may project; neighboring read/render edits may not.
 const changed = current.replace('const reader = createNoteReader', 'const reader = changedNoteReader');
 assert.notEqual(changed, current);
 assert.throws(() => validateActorEmojiCacheEvidence(undefined, file => file === path ? Buffer.from(changed) : read(file), () => null), /measured current input drift/);
 let stale = false;
 const live = file => stale && file === path ? Buffer.from(previous) : read(file);
 const optional = () => null;
 inEvidenceValidationScope(() => {
  readForActorEmojiCacheEvidence(path, live, optional);
  stale = true;
  assert.throws(() => readForActorEmojiCacheEvidence(path, live, optional), /measured current input drift/);
 });
});
