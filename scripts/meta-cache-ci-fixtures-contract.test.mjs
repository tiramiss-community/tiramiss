/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ciFixtureFiles, readPreMetaCacheCiFixtures, validateMetaCacheCiFixtures } from './meta-cache-ci-fixtures-evidence.mjs';
import { readPreUrlPreview } from './url-preview-evidence.mjs';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/meta-cache/';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const current = () => JSON.parse(read(directory + 'ci-fixtures-current-evidence.json'));

test('CI fixture successor restores exactly five inputs through the terminal history reader', () => {
 const previous = validateMetaCacheCiFixtures(undefined, read, () => null);
 assert.deepEqual(Object.keys(previous), ciFixtureFiles);
 for (const path of ciFixtureFiles) {
  assert.equal(readPreMetaCacheCiFixtures(path, 'utf8'), previous[path]);
  assert.equal(readPreUrlPreview(path, 'utf8'), previous[path]);
  assert.equal(readPreAliasKey(path, 'utf8'), previous[path]);
  assert.notEqual(sha(read(path)), sha(Buffer.from(previous[path])));
 }
 assert.equal(readPreMetaCacheCiFixtures('unrelated', 'utf8', () => Buffer.from('live')), 'live');
});
for (const path of ciFixtureFiles) {
 test(`CI fixture current drift is rejected at both direct and inherited projection: ${path}`, () => {
  const changed = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
  assert.throws(() => readPreMetaCacheCiFixtures(ciFixtureFiles[0], undefined, changed, () => null), /Meta cache measured current input drift/);
  assert.throws(() => readPreUrlPreview(ciFixtureFiles[0], undefined, changed, () => null), /Meta cache measured current input drift/);
 });
}
test('CI fixture seals and every optional artifact reject forgery', () => {
 for (const path of ['ci-fixtures-current-evidence.json', 'ci-fixtures-predecessor.json']) {
  assert.throws(() => validateMetaCacheCiFixtures(undefined, file => file === directory + path ? Buffer.from('{}') : read(file), () => null), /seal/);
 }
 const value = current(); value.nodeVersion = '24.20.0';
 assert.throws(() => validateMetaCacheCiFixtures(value, read, () => null), /receipt seal/);
 for (const run of current().runs) {
  assert.throws(() => validateMetaCacheCiFixtures(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 }
});
test('CI fixture current bytes are rechecked after validation and on later calls; buffers and maps are independent', () => {
 const path = ciFixtureFiles[0]; let reads = 0;
 const changesOnSecondRead = file => file === path && ++reads > 1 ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 assert.throws(() => readPreMetaCacheCiFixtures(path, undefined, changesOnSecondRead, () => null), /Meta cache measured current input drift/);
 const map = validateMetaCacheCiFixtures(undefined, read, () => null); map[path] = 'forged';
 assert.notEqual(validateMetaCacheCiFixtures(undefined, read, () => null)[path], 'forged');
 const bytes = readPreMetaCacheCiFixtures(path); bytes[0] = 0;
 assert.notEqual(readPreMetaCacheCiFixtures(path)[0], 0);
 const changed = file => file === ciFixtureFiles[4] ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
 assert.throws(() => readPreMetaCacheCiFixtures(path, undefined, changed, () => null), /Meta cache measured current input drift/);
});
test('CI fixture follow-up preserves the earlier27/33 measured receipt and predecessor exactly', () => {
 assert.equal(sha(read(directory + 'current-evidence.json')), 'e8cc0d48df6e8106a613ee696c93f4ccddc618f0dfcdd01d19101b8566a46781');
 assert.equal(sha(read(directory + 'predecessor.json')), 'a42857e97f501a7c489b748e4157b36e2af53803f3f82b1b1ae2eb0e58989d0b');
 assert.equal(current().runs.find(run => run.name === 'unit').passed, 4371);
 assert.equal(current().runs.find(run => run.name === 'integration').passed, 1611);
});
test('CI fixture helper imports only builtins, scope and its worker-log successor leaf without Git or ancestor readers', () => {
 const source = read('scripts/meta-cache-ci-fixtures-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:') || ['./evidence-validation-scope.mjs', './worker-logging-integration-evidence.mjs', './announcement-archive-predecessor.mjs'].includes(match[1])));
 const successor = read('scripts/worker-logging-integration-evidence.mjs').toString();
 assert([...successor.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:')));
 assert(!/execFile|spawn|import\(/.test(source + successor));
});
