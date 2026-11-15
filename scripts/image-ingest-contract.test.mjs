/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPreImageIngestDependencyReader } from './image-ingest-dependency-evidence.mjs';
const root = new URL('../', import.meta.url);
const directory = 'docs/superpowers/compatibility/image-ingest/';
const read = path => readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = JSON.parse(read(directory + 'dependency-predecessor.json'));

test('image ingest dependency successor restores exactly two sealed historical inputs', () => {
	const before = createPreImageIngestDependencyReader(read);
	assert.deepEqual(Object.keys(previous.files), ['packages/backend-next/package.json', 'pnpm-lock.yaml']);
	for (const [path, proof] of Object.entries(previous.files)) {
		assert.equal(sha(before(path)), proof.previousSha256);
		assert.notEqual(sha(before(path)), sha(read(path)));
	}
	assert.deepEqual(before('packages/backend-next/src/modules/drive/image-ingest.ts'), read('packages/backend-next/src/modules/drive/image-ingest.ts'));
});
for (const path of [...Object.keys(previous.files), directory + 'dependency-predecessor.json']) {
	test(`dependency projection rejects live drift: ${path}`, () => {
		const drifted = p => p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p);
		const before = createPreImageIngestDependencyReader(drifted);
		assert.throws(() => before(path.endsWith('dependency-predecessor.json') ? 'pnpm-lock.yaml' : path), /seal|measured current input drift/);
	});
}
test('dependency reader rechecks a changed second input without retaining stale bytes', () => {
	let changed = false;
	const before = createPreImageIngestDependencyReader(path => changed && path === 'pnpm-lock.yaml' ? Buffer.concat([read(path), Buffer.from('\n')]) : read(path));
	before('pnpm-lock.yaml');
	changed = true;
	assert.throws(() => before('pnpm-lock.yaml'), /measured current input drift/);
});
test('source observations bind fixed bytes and four pinned upstream sources', () => {
	const fixtures = JSON.parse(read(directory + 'fixtures.json'));
	const observations = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observations.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observations.corpusSha256, sha(read(directory + 'fixtures.json')));
	assert.deepEqual(observations.manifest.map(m => m.path), ['packages/backend/src/core/FileInfoService.ts', 'packages/backend/src/core/ImageProcessingService.ts', 'packages/backend/src/core/DriveService.ts', 'packages/backend/src/misc/is-mime-image.ts']);
	assert.deepEqual(observations.cases.map(c => c.id), fixtures.fixtures.map(f => f.id));
	assert.equal(observations.cases.length, 28);
	assert.equal(observations.cases.flatMap(c => c.alts ?? []).length, 56);
	assert.equal(observations.cases.flatMap(c => c.conversions ?? []).length, 9);
	assert.equal(observations.failures.length, 3);
	assert.equal(observations.versions.sharp, '0.35.5');
});
