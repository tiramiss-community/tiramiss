/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectWellKnownInput } from './well-known-predecessor.mjs';
import assert from 'node:assert/strict';
import { readPrePublicDocuments } from './public-documents-evidence.mjs';
import { readForActorEmojiCacheEvidence } from './actor-emoji-cache-evidence.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sharedPath = 'packages/backend-next/test/unit/composition/http-app.test.ts';
const predecessorPath = 'docs/superpowers/compatibility/joint-drive-meta/predecessor.json';
const seal = 'bd589b0d2efadff3851f04e8b3e3f63c824d7babb130fb20e338f26ac991c663';
const read = file => readFileSync(new URL('../' + file, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Only this auto-merged fixture changed both feature receipts. Each view keeps
// its own original current-input checks; neither old receipt is renewed here.
function project(file, readFile, feature, label) {
 const currentRead = readFile;
 readFile = path => readPrePublicDocuments(path, currentRead);
 if (file !== sharedPath) return readForActorEmojiCacheEvidence(file, readFile);
 const bytes = readFile(predecessorPath);
 assert.equal(hash(bytes), seal, 'joint drive/meta predecessor seal');
 const previous = JSON.parse(bytes);
 assert.deepEqual(previous.heads, { driveFiles: '886cd622749a6baf125eb290f7dd16798acaa4b1', metaCache: '1e233948c7f220a72a13c96d8ad4720db19b98c0' });
 assert.equal(previous.path, sharedPath);
 assert.deepEqual(Object.keys(previous.predecessors), ['driveFiles', 'metaCache']);
 assert.equal(hash(readFile(sharedPath)), previous.currentSha256, `${label} measured current input drift: ${sharedPath} (joint composition)`);
 const before = Buffer.from(previous.predecessors[feature]);
 assert.notEqual(hash(before), previous.currentSha256);
 return before;
}
export function readForDriveFileEvidence(file, readFile = read) {
 return project(file, readFile, 'driveFiles', 'drive file');
}
export function readForMetaCacheEvidence(file, readFile = read) {
 return projectWellKnownInput(file, project(file, readFile, 'metaCache', 'Meta cache'));
}
