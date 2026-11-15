/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readPreInternalEvents, validateInternalEventsSuccessor } from './internal-events-evidence.mjs';
import { readPreUrlPreview, validateUrlPreviewSuccessor } from './url-preview-evidence.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const evidencePath = 'docs/superpowers/compatibility/internal-events/current-evidence.json';
const predecessorPath = 'docs/superpowers/compatibility/internal-events/predecessor.json';
const projected = 'packages/backend-next/src/platform/connect-resources.ts';
const projectedPaths = [projected, 'packages/backend-next/src/platform/note-antennas.ts', 'packages/backend-next/src/platform/role-material-cache.ts', 'packages/backend-next/src/platform/role-materials.ts', 'packages/backend-next/src/platform/user-webhooks.ts', 'packages/backend-next/test/unit/note/antennas.test.ts', 'packages/backend-next/test/unit/user-webhooks-reconnect.test.ts', 'packages/backend-next/test/unit/user-webhooks-startup.test.ts'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = () => JSON.parse(read(evidencePath));
test('current measured internal reception restores exactly eight changed historical inputs', () => {
 const result = validateInternalEventsSuccessor(undefined, read, () => null);
 assert.deepEqual(Object.keys(result), projectedPaths);
 for (const path of projectedPaths) {
  assert.notEqual(sha(readPreInternalEvents(path)), sha(read(path)), path);
  if (path !== projected) assert.equal(readPreUrlPreview(path, 'utf8'), result[path]);
 }
 assert.notEqual(sha(readPreInternalEvents(projected)), sha(read(projected)));
 assert.equal(sha(readPreInternalEvents(projected)), JSON.parse(read('docs/superpowers/compatibility/url-preview/current-evidence.json')).inputs[projected]);
 assert.equal(readPreInternalEvents('unrelated', 'utf8', () => Buffer.from('live'), () => null), 'live');
 validateUrlPreviewSuccessor(undefined, read, () => null);
 assert.notEqual(sha(readPreUrlPreview(projected)), sha(read(projected)));
});
test('every current measured source/test input rejects drift before historical projection', () => {
 for (const path of Object.keys(record().inputs)) {
  const changed = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
  assert.throws(() => validateInternalEventsSuccessor(undefined, changed, () => null), /measured current input drift/);
  assert.throws(() => readPreUrlPreview(projected, undefined, changed, () => null), /measured current input drift/);
  if (projectedPaths.includes(path)) assert.throws(() => readPreUrlPreview(path, undefined, changed, () => null), /measured current input drift/);
 }
});
test('sealed receipts and predecessor reject corruption even without host artifacts', () => {
 for (const path of [evidencePath, predecessorPath]) {
  const corrupt = p => p === path ? Buffer.from('{}') : read(p);
  assert.throws(() => readPreInternalEvents(projected, undefined, corrupt, () => null), /seal/);
 }
 const changed = record(); changed.runtimeRevision = '0'.repeat(40);
 assert.throws(() => validateInternalEventsSuccessor(changed, read, () => null), /receipt seal/);
});
test('present logs and runtime receipt must agree; offline validation cannot invent a run', () => {
 for (const run of record().runs) assert.throws(() => validateInternalEventsSuccessor(undefined, read, p => p === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
 assert.throws(() => validateInternalEventsSuccessor(undefined, read, p => p.endsWith('product-run-receipt.json') ? Buffer.from('{}') : null), /actual receipt drift/);
});
test('warm parsed records still read/hash actual inputs and return independent projections', () => {
 let changed;
 const changing = path => path === changed ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path);
 const before = validateInternalEventsSuccessor(undefined, changing, () => null);
 before[projected] = 'forged';
 assert.notEqual(validateInternalEventsSuccessor(undefined, changing, () => null)[projected], 'forged');
 changed = projected;
 assert.throws(() => validateInternalEventsSuccessor(undefined, changing, () => null), /measured current input drift/);
});
