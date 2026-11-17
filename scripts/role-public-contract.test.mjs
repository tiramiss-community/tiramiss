/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { projectPublicRoleInput } from './notes-pagination-evidence.mjs';

const root = new URL('../', import.meta.url);
const path = 'packages/backend-next/test/unit/composition/http-app.test.ts';
const read = path => readFileSync(new URL(path, root));

test('Role observation bytes bind to the shared corpus and contain actual successful public responses', () => {
 const corpus = read('docs/superpowers/compatibility/role-public/corpus.json');
 const observations = JSON.parse(read('docs/superpowers/compatibility/role-public/observations.json'));
 assert.equal(observations.corpusSha256, createHash('sha256').update(corpus).digest('hex'));
 assert.equal(observations.cases.length, 9);
 assert.equal(observations.cases[0].status, 200);
 assert.equal(observations.cases[0].body[0].usersCount, 2);
 assert(observations.userRoles.some(role => role.name === 'conditional'));
});

test('only the exact public Role assertion projects to its immutable predecessor', () => {
 const bytes = read(path);
 const before = projectPublicRoleInput(path, bytes);
 assert.equal(before.toString().includes("'/api/roles/list'"), false);
 assert.deepEqual(projectPublicRoleInput(path, before), before);
 assert.throws(() => projectPublicRoleInput(path, Buffer.concat([bytes, Buffer.from('\n')])));
 assert.deepEqual(projectPublicRoleInput('unrelated', bytes), bytes);
});

test('standalone Announcement and combined Role/Announcement bytes preserve exact shared predecessors and reject drift', async () => {
 const { projectUserMemoInput, projectAnnouncementReadInput } = await import('./notes-pagination-evidence.mjs');
 const { projectUserMemoEntityInput, projectAnnouncementEntityInput } = await import('./package-imports-evidence.mjs');
 const proof = JSON.parse(read('docs/superpowers/compatibility/role-public/followup-predecessor.json'));
 const sha = bytes => createHash('sha256').update(bytes).digest('hex');
 const forward = (before, binding) => {
  let value = Buffer.from(before);
  assert.equal(sha(value), binding.previousSha256);
  for (const patch of binding.patches) {
   const previous = Buffer.from(patch.previous);
   assert.deepEqual(value.subarray(patch.offset, patch.offset + previous.length), previous);
   value = Buffer.concat([value.subarray(0, patch.offset), Buffer.from(patch.insert), value.subarray(patch.offset + previous.length)]);
  }
  assert.equal(sha(value), binding.currentSha256);
  return value;
 };
 for (const [path, variants] of Object.entries(proof.notes)) {
  for (const binding of variants) {
   const actual = read(path);
   const candidates = [actual, projectAnnouncementReadInput(path, actual), projectPublicRoleInput(path, actual)];
   const before = candidates.find(bytes => sha(bytes) === binding.previousSha256);
   assert(before);
   const next = forward(before, binding);
   assert.deepEqual(projectUserMemoInput(path, next), projectUserMemoInput(path, before));
   if (path.endsWith('/test/unit/composition/http-app.test.ts')) {
    assert.deepEqual(projectPublicRoleInput(path, next), projectPublicRoleInput(path, before));
   }
   assert.throws(() => projectUserMemoInput(path, Buffer.concat([next, Buffer.from('\n')])), /input drift/);
  }
 }
 for (const [path, binding] of Object.entries(proof.package)) {
  const before = projectAnnouncementEntityInput(path, read(path));
  const next = forward(before, binding);
  assert.deepEqual(projectUserMemoEntityInput(path, next), projectUserMemoEntityInput(path, before));
  assert.throws(() => projectUserMemoEntityInput(path, Buffer.concat([next, Buffer.from('\n')])), /measured input/);
 }
});

test('Announcement publisher fix restores only its frozen root bytes through the direct Page entry', async () => {
 const { projectAnnouncementReadInput, projectPageReadInput } = await import('./notes-pagination-evidence.mjs');
 const proof = JSON.parse(read('docs/superpowers/compatibility/role-public/announcement-fix-predecessor.json'));
 const sha = bytes => createHash('sha256').update(bytes).digest('hex');
 const before = projectAnnouncementReadInput(proof.path, read(proof.path));
 assert.equal(sha(before), proof.binding.previousSha256);
 let actual = before;
 for (const patch of proof.binding.patches) {
  const previous = Buffer.from(patch.previous);
  assert.deepEqual(actual.subarray(patch.offset, patch.offset + previous.length), previous);
  actual = Buffer.concat([actual.subarray(0, patch.offset), Buffer.from(patch.insert), actual.subarray(patch.offset + previous.length)]);
 }
 assert.equal(sha(actual), proof.binding.currentSha256);
 assert.deepEqual(projectPageReadInput(proof.path, actual), projectPageReadInput(proof.path, before));
 assert.throws(() => projectPageReadInput(proof.path, Buffer.concat([actual, Buffer.from('\n')])), /input drift/);
});
