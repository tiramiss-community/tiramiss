/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { queueSessionObservationPath, readPreQueueSessionObservation, validateQueueSessionObservation } from './queue-session-observation-evidence.mjs';
import { readPreUrlPreview } from './url-preview-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'docs/superpowers/compatibility/internal-events/';
const receiptPath = directory + 'queue-session-observation-evidence.json';
const predecessorPath = directory + 'queue-session-observation-predecessor.json';
const record = () => JSON.parse(read(receiptPath));
test('the measured cleanup observation fixture projects exactly its prior test bytes', () => {
 const result = validateQueueSessionObservation(undefined, read, () => null);
 assert.deepEqual(Object.keys(result), [queueSessionObservationPath]);
 assert.notEqual(sha(read(queueSessionObservationPath)), sha(Buffer.from(result[queueSessionObservationPath])));
 assert.equal(readPreQueueSessionObservation(queueSessionObservationPath, 'utf8'), result[queueSessionObservationPath]);
 assert.equal(readPreUrlPreview(queueSessionObservationPath, 'utf8'), result[queueSessionObservationPath]);
 assert.equal(readPreQueueSessionObservation('unrelated', 'utf8', () => Buffer.from('live'), () => null), 'live');
});
test('a changed actual fixture rejects through the direct and historical readers', () => {
 const changed = path => path === queueSessionObservationPath ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 assert.throws(() => readPreQueueSessionObservation(queueSessionObservationPath, undefined, changed, () => null), /measured fixture input drift/);
 assert.throws(() => readPreUrlPreview(queueSessionObservationPath, undefined, changed, () => null), /measured fixture input drift/);
});
test('receipt and prior test corruption reject without optional host artifacts', () => {
 for (const path of [receiptPath, predecessorPath]) {
  assert.throws(() => validateQueueSessionObservation(undefined, p => p === path ? Buffer.from('{}') : read(p), () => null), /seal/);
 }
 const value = record(); value.run.exitCode = 1;
 assert.throws(() => validateQueueSessionObservation(value, read, () => null), /receipt seal/);
});
test('available measured process log and raw receipt must match recorded bytes', () => {
 assert.throws(() => validateQueueSessionObservation(undefined, read, path => path === record().run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateQueueSessionObservation(undefined, read, path => path.endsWith('fixture-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
});
