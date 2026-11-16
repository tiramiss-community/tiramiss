/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readForDriveFileEvidence, readForMetaCacheEvidence } from './joint-drive-meta-evidence.mjs';
import { readPrePublicDocuments } from './public-documents-evidence.mjs';
const path = 'packages/backend-next/test/unit/composition/http-app.test.ts';
const fixturePath = 'docs/superpowers/compatibility/joint-drive-meta/predecessor.json';
const read = file => readFileSync(new URL('../' + file, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, project] of [['driveFiles', readForDriveFileEvidence], ['metaCache', readForMetaCacheEvidence]]) {
 test(`${name}: exact combined unit input restores only its original feature perspective`, () => {
  const fixture = JSON.parse(read(fixturePath));
  assert.equal(hash(readPrePublicDocuments(path, read)), fixture.currentSha256);
  assert.equal(project(path, read).toString(), fixture.predecessors[name]);
  assert.notEqual(hash(project(path, read)), fixture.currentSha256);
  assert.equal(project('unrelated', () => Buffer.from('live')).toString(), 'live');
 });
 test(`${name}: changed combined bytes and a prior perspective cannot be accepted as current`, () => {
  assert.throws(() => project(path, file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file)), /measured current input drift/);
  const previous = project(path, read);
  assert.throws(() => project(path, file => file === path ? previous : read(file)), /measured current input drift/);
 });
 test(`${name}: seal corruption and drift on a later read always reject`, () => {
  assert.throws(() => project(path, file => file === fixturePath ? Buffer.from('{}') : read(file)), /predecessor seal/);
  let changed = false;
  const fresh = file => file === path && changed ? Buffer.from('changed') : read(file);
  project(path, fresh); changed = true;
  assert.throws(() => project(path, fresh), /measured current input drift/);
 });
}
