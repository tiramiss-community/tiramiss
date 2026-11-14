/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fixturePath, readPrePreviewFixture, validatePreviewFixture } from './url-preview-fixture-evidence.mjs';
import { readPreUrlPreview } from './url-preview-evidence.mjs';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const sha = value => createHash('sha256').update(value).digest('hex');
const evidencePath = 'docs/superpowers/compatibility/url-preview/fixture-correction-evidence.json';
const predecessorPath = 'docs/superpowers/compatibility/url-preview/fixture-correction-predecessor.json';
const record = () => JSON.parse(read(evidencePath));
test('one measured mock correction projects its exact historical bytes through older readers', () => {
 validatePreviewFixture();
 const previous = validatePreviewFixture(record(), read, () => null);
 assert.deepEqual(Object.keys(previous), [fixturePath]);
 assert.equal(sha(readPrePreviewFixture(fixturePath)), '0e91899d797f7a9e94930966ce4e909f24d6054872ffbfe5ecd176146efd5f78');
 assert.deepEqual(readPreUrlPreview(fixturePath), readPrePreviewFixture(fixturePath));
 assert.deepEqual(readPreAliasKey(fixturePath), readPrePreviewFixture(fixturePath));
 assert.equal(sha(read('docs/superpowers/compatibility/url-preview/current-evidence.json')), 'b62bd5348c84d0c9f8f8e098400782eeca9264d8cfb3cbea03bf08c89252f501');
});
test('current mock input drift rejects directly and through the historical URL reader', () => {
 const drifted = path => path === fixturePath ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 assert.throws(() => validatePreviewFixture(record(), drifted, () => null), /mock correction measured input drift/);
 assert.throws(() => readPreUrlPreview(fixturePath, undefined, drifted, () => null), /mock correction measured input drift/);
});
test('receipt/predecessor corruption and failed or incomplete measurements reject offline', () => {
 for (const path of [evidencePath, predecessorPath]) assert.throws(() => readPrePreviewFixture(fixturePath, undefined, p => p === path ? Buffer.from('{}') : read(p), () => null), /seal/);
 for (const mutate of [v => { v.noInputDrift = false; }, v => { v.runs[1].exitCode = 1; }, v => { v.runs[1].passed--; }, v => { v.inputsAfter = {}; }]) {
  const value = record(); mutate(value);
  assert.throws(() => validatePreviewFixture(value, read, () => null), /receipt seal/);
 }
});
test('available actual logs and receipt reject corruption; explicit offline mode stays strict', () => {
 for (const run of record().runs) assert.throws(() => validatePreviewFixture(record(), read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validatePreviewFixture(record(), read, p => p.endsWith('fixture-correction-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
 assert.doesNotThrow(() => validatePreviewFixture(record(), read, () => null));
});
test('one-file leaf uses only builtins, launches no subprocess and passes outside paths through', () => {
 const source = read('scripts/url-preview-fixture-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(m => m[1].startsWith('node:')));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPrePreviewFixture('unrelated', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
