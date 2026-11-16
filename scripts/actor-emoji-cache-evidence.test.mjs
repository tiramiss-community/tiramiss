/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { actorEmojiCacheFiles, readForActorEmojiCacheEvidence, validateActorEmojiCacheEvidence } from './actor-emoji-cache-evidence.mjs';
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
 inEvidenceValidationScope(() => {
  readForActorEmojiCacheEvidence(requested, dynamic, () => null); changed = requested;
  assert.throws(() => readForActorEmojiCacheEvidence(requested, dynamic, () => null), /measured current input drift/);
  assert(Buffer.isBuffer(readForActorEmojiCacheEvidence(requested, read, () => null)));
 });
 assert.throws(() => readForActorEmojiCacheEvidence(requested, dynamic, () => null), /measured current input drift/);
 changed = undefined;
 const mutable = readForActorEmojiCacheEvidence(requested, dynamic, () => null); mutable[0] = 0;
 assert.notEqual(readForActorEmojiCacheEvidence(requested, dynamic, () => null)[0], 0);
});
