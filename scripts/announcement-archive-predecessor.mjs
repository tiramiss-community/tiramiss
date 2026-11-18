/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/announcement-archive/compatibility-predecessor.json', import.meta.url));
assert.equal(sha(record), '9ee311b9b8ee367a0a83a7d2f3c471ecdfca826e1af4fa47cb250ba3a02bd20b', 'announcement archive predecessor seal');
const { files } = JSON.parse(record);

// Only exact #449/#450 inputs project to their historical bytes; unknown drift
// continues to the existing evidence guards.
export function projectAnnouncementArchiveInput(path, actual) {
 const binding = files[path];
 if (!binding || sha(actual) !== binding.currentSha256) return actual;
 let previous = Buffer.from(actual);
 for (const patch of [...binding.patches].reverse()) {
  const inserted = Buffer.from(patch.insert);
  assert.deepEqual(previous.subarray(patch.offset, patch.offset + inserted.length), inserted, 'announcement archive predecessor anchor');
  previous = Buffer.concat([previous.subarray(0, patch.offset), Buffer.from(patch.previous), previous.subarray(patch.offset + inserted.length)]);
 }
 assert.equal(sha(previous), binding.previousSha256, 'announcement archive predecessor identity');
 return previous;
}
