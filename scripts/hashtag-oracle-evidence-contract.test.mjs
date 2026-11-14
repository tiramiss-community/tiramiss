/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readPreHashtagOracle, successorFiles, validateHashtagOracleSuccessor } from './hashtag-oracle-evidence.mjs';
import { readPreAliasKey } from './local-actor-alias-key-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const prefix = 'docs/superpowers/compatibility/note/hashtag/';
const record = () => JSON.parse(read(prefix + 'oracle-schedule-evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('one-file renewal checks current tests and unchanged product/source oracle before restoring historical bytes', () => {
 const previous = validateHashtagOracleSuccessor();
 validateHashtagOracleSuccessor(record(), read, () => null);
 assert.deepEqual(Object.keys(previous), successorFiles);
 assert.equal(readPreHashtagOracle(successorFiles[0], 'utf8'), previous[successorFiles[0]]);
 assert.equal(readPreAliasKey(successorFiles[0], 'utf8'), previous[successorFiles[0]]);
 assert.notEqual(sha(read(successorFiles[0])), sha(Buffer.from(previous[successorFiles[0]])));
});
for (const path of Object.keys(record().inputs)) test(`reject current drift before projecting measured hashtag test: ${path}`, () => {
 const drifted = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
 assert.throws(() => readPreHashtagOracle(successorFiles[0], undefined, drifted, () => null), /measured input drift/);
 assert.throws(() => readPreAliasKey(successorFiles[0], undefined, drifted, () => null), /measured input drift/);
});
test('modified counts, test failures and missing input proof cannot replace the sealed run', () => {
 for (const change of [v => { v.noInputDrift = false; }, v => { v.runs[0].passed--; }, v => { v.runs[1].exitCode = 1; }, v => { v.inputsAfter = {}; }]) {
  const value = record(); change(value);
  assert.throws(() => validateHashtagOracleSuccessor(value, read, () => null), /receipt seal/);
 }
 for (const name of ['oracle-schedule-evidence.json', 'oracle-schedule-predecessor.json']) assert.throws(() => readPreHashtagOracle(successorFiles[0], undefined, p => p === prefix + name ? Buffer.from('{}') : read(p), () => null), /seal/);
});
test('available raw logs and host receipt are checked; explicit offline readers do not read host artifacts', () => {
 for (const run of record().runs) assert.throws(() => validateHashtagOracleSuccessor(record(), read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateHashtagOracleSuccessor(record(), read, p => p.endsWith('/verification.json') ? Buffer.from('{}') : null), /actual receipt drift/);
 assert.doesNotThrow(() => validateHashtagOracleSuccessor(record(), read, () => null));
});
test('the new terminal reader uses only builtins and leaves unrelated bytes untouched', () => {
 const source = read('scripts/hashtag-oracle-evidence.mjs').toString();
 assert([...source.matchAll(/from ['"]([^'"]+)['"]/g)].every(match => match[1].startsWith('node:')));
 assert(!/execFile|spawn|import\(/.test(source));
 assert.equal(readPreHashtagOracle('unrelated.ts', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
