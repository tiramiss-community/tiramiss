/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readPreMetaCache, validateMetaCacheSuccessor, metaCachePredecessorFiles, createValidatedMetaPredecessorReader } from './meta-cache-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/meta-cache/';
const read = path => readFileSync(new URL(path, root));
const record = () => JSON.parse(read(directory + 'current-evidence.json'));

test('Meta cache restores exactly27 historical inputs after validating all33 measured inputs', () => {
 const old = JSON.parse(read(directory + 'predecessor.json'));
 assert.equal(metaCachePredecessorFiles.length, 27);
 assert.equal(Object.keys(record().inputs).length, 33);
 assert.deepEqual(validateMetaCacheSuccessor(undefined, read, () => null), old.files);
 for (const path of metaCachePredecessorFiles) {
  assert.equal(readPreMetaCache(path, 'utf8', read, () => null), old.files[path]);
  assert.notEqual(old.files[path], read(path).toString());
 }
 assert.equal(readPreMetaCache('unrelated', 'utf8', () => Buffer.from('live')), 'live');
});
for (const path of Object.keys(record().inputs)) {
 test(`Meta cache rejects current drift including newly added material: ${path}`, () => {
  const changed = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
  const expected = path === 'packages/backend-next/test/unit/composition/http-app.test.ts' ? /(?:Meta cache measured current input drift|measured current input drift \(notes pagination(?: requested)?\))/ : /Meta cache measured current input drift/;
  assert.throws(() => validateMetaCacheSuccessor(undefined, changed, () => null), expected);
  assert.throws(() => readPreMetaCache(metaCachePredecessorFiles[0], undefined, changed, () => null), expected);
 });
}
test('Meta cache receipt/predecessor seals reject corruption without optional logs', () => {
 for (const path of ['current-evidence.json', 'predecessor.json']) {
  const changed = p => p === directory + path ? Buffer.from('{}') : read(p);
  assert.throws(() => validateMetaCacheSuccessor(undefined, changed, () => null), /seal/);
 }
 const forged = record(); forged.postingComplete = true;
 assert.throws(() => validateMetaCacheSuccessor(forged, read, () => null), /receipt seal/);
});
test('Meta cache validates every present log and never accepts a prior projection as current bytes', () => {
 for (const run of record().runs) {
  assert.throws(() => validateMetaCacheSuccessor(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 }
 const previous = validateMetaCacheSuccessor(undefined, read, () => null);
 const projected = path => Object.hasOwn(previous, path) ? Buffer.from(previous[path]) : read(path);
 assert.throws(() => validateMetaCacheSuccessor(undefined, projected, () => null), /(?:Meta cache measured current input drift|measured current input drift \(notes pagination(?: requested)?\))/);
});
test('Meta cache repeated calls read actual bytes again and return independent maps', () => {
 let changed;
 const reader = path => path === changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 const old = validateMetaCacheSuccessor(undefined, reader, () => null);
 old[metaCachePredecessorFiles[0]] = 'forged';
 assert.notEqual(validateMetaCacheSuccessor(undefined, reader, () => null)[metaCachePredecessorFiles[0]], 'forged');
 changed = 'packages/backend-next/src/platform/meta-cache.ts';
 assert.throws(() => validateMetaCacheSuccessor(undefined, reader, () => null), /Meta cache measured current input drift/);
});
test('Meta cache terminal helper imports only builtins without Git, subprocesses or historical ancestor readers', () => {
 const source = read('scripts/meta-cache-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => (match[1].startsWith('node:') || match[1] === './evidence-validation-scope.mjs' || match[1] === './joint-drive-meta-evidence.mjs')));
 assert(!/execFile|spawn|import\(/.test(source));
});

test('validated invocation closures recheck requested input bytes and isolate distinct readers', () => {
 const requested = metaCachePredecessorFiles[0];
 let changed;
 const changing = path => path === changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 const first = createValidatedMetaPredecessorReader(changing, () => null);
 const second = createValidatedMetaPredecessorReader(read, () => null);
 assert.equal(first(requested, 'utf8'), second(requested, 'utf8'));
 const mutable = first(requested); mutable[0] = 0;
 assert.notEqual(first(requested)[0], 0);
 changed = requested;
 assert.throws(() => first(requested), /Meta cache measured current input drift/);
 assert.equal(typeof second(requested, 'utf8'), 'string');
 changed = 'packages/backend-next/src/platform/meta-cache.ts';
 assert.throws(() => first(changed), /Meta cache measured current input drift/);
 assert.throws(() => createValidatedMetaPredecessorReader(changing, () => null), /Meta cache measured current input drift/);
});
test('every independent public terminal validator checks a non-requested new cache input', async () => {
 const path = 'packages/backend-next/src/platform/meta-cache.ts';
 const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 const internal = await import('./internal-events-evidence.mjs');
 const folders = await import('./drive-folders-evidence.mjs');
 const pubsub = await import('./drive-folder-pubsub-evidence.mjs');
 const preview = await import('./url-preview-evidence.mjs');
 const admin = await import('./instance-admin-evidence.mjs');
 for (const validate of [internal.validateInternalEventsSuccessor, folders.validateDriveFoldersSuccessor, pubsub.validateDriveFolderPubsubSuccessor, preview.validateUrlPreviewSuccessor, admin.validateInstanceAdminSuccessor]) {
  assert.throws(() => validate(undefined, changed, () => null), /Meta cache measured current input drift/);
  assert.throws(() => validate(undefined, changed, () => null), /Meta cache measured current input drift/);
 }
});
