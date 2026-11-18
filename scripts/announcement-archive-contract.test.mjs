/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectAnnouncementArchiveInput } from './announcement-archive-predecessor.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = JSON.parse(read('docs/superpowers/compatibility/announcement-archive/compatibility-predecessor.json'));

test('archive successor preserves the exact finite historical inputs and passes unknown drift to guards', () => {
 assert.equal(record.productRevision, '4597043a15692a1a35f60bbc4490a66afef76edd');
 for (const [path, binding] of Object.entries(record.files)) {
  const current = read(path);
  assert.equal(sha(current), binding.currentSha256);
  assert.equal(sha(projectAnnouncementArchiveInput(path, current)), binding.previousSha256);
  const drift = Buffer.concat([current, Buffer.from('\n')]);
  assert.equal(projectAnnouncementArchiveInput(path, drift), drift);
 }
 const unrelated = Buffer.from('unrelated');
 assert.equal(projectAnnouncementArchiveInput('unrelated', unrelated), unrelated);
});
