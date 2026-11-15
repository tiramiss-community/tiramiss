/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const path = 'docs/superpowers/compatibility/drive-files/predecessor.json';
const seal = '13e86db07c278fbdfbf9a52786e77e4ef3b042f7903b8bbc02c79b804f77b650';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => readFileSync(new URL(file, root));
export const driveFilePredecessorFiles = Object.freeze([
 'packages/backend-next/src/composition/http-app.ts',
 'packages/backend-next/test/unit/composition/http-app.test.ts',
 'packages/backend-next/src/platform/database/note-files.ts',
]);
// This bounded source transition preserves historical measurements; it does not renew them.
export function readPreDriveFiles(file, encoding, readFile = read) {
 if (!driveFilePredecessorFiles.includes(file)) {
  const bytes = readFile(file);
  return encoding ? bytes.toString(encoding) : bytes;
 }
 const bytes = readFile(path);
 assert.equal(sha(bytes), seal, 'drive file predecessor seal');
 const previous = JSON.parse(bytes);
 assert.equal(previous.commit, '1adb04b0cf4d6efdb2537891df4ca2261359f1f6');
 assert.deepEqual(Object.keys(previous.files), driveFilePredecessorFiles);
 assert.deepEqual(Object.keys(previous.currentInputs), driveFilePredecessorFiles);
 for (const input of driveFilePredecessorFiles) {
  assert.equal(sha(readFile(input)), previous.currentInputs[input], `drive file measured current input drift: ${input}`);
  assert.notEqual(sha(Buffer.from(previous.files[input])), previous.currentInputs[input]);
 }
 const prior = Buffer.from(previous.files[file]);
 return encoding ? prior.toString(encoding) : prior;
}
