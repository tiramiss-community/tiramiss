/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPreVideoIngestDependencyReader } from './video-ingest-dependency-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/video-ingest/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prior = JSON.parse(read(directory + 'dependency-predecessor.json'));

test('video dependency successor restores exactly two sealed inputs and passes unrelated bytes through', () => {
	const before = createPreVideoIngestDependencyReader(read);
	assert.deepEqual(Object.keys(prior.files), ['packages/backend-next/package.json', 'pnpm-lock.yaml']);
	for (const [path, record] of Object.entries(prior.files)) {
		assert.equal(sha(before(path)), record.previousSha256);
		assert.notEqual(sha(before(path)), sha(read(path)));
	}
	assert.equal(createPreVideoIngestDependencyReader(() => Buffer.from('live'))('unrelated').toString(), 'live');
});
for (const path of [...Object.keys(prior.files), directory + 'dependency-predecessor.json']) {
	test(`video dependency projection rejects live drift and drift after an earlier read: ${path}`, () => {
		let drift = false;
		const before = createPreVideoIngestDependencyReader(p => drift && p === path ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p));
		before('pnpm-lock.yaml');
		drift = true;
		assert.throws(() => before(path.endsWith('dependency-predecessor.json') ? 'pnpm-lock.yaml' : path), /seal|measured current input drift/);
	});
}
test('video source observations bind fixed bytes, four pinned sources, actual frames, failures and cleanup', () => {
	const fixtures = JSON.parse(read(directory + 'fixtures.json'));
	const observed = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observed.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observed.corpusSha256, sha(read(directory + 'fixtures.json')));
	assert.deepEqual(observed.manifest.map(m => m.path), ['packages/backend/src/core/VideoProcessingService.ts', 'packages/backend/src/core/ImageProcessingService.ts', 'packages/backend/src/core/DriveService.ts', 'packages/backend/src/misc/prelude/url.ts']);
	assert.deepEqual(observed.cases.map(c => c.id), fixtures.fixtures.map(f => f.id));
	assert.equal(observed.cases.length, 5);
	assert.equal(observed.cases.filter(c => c.rejects).length, 3);
	assert.equal(observed.cases[0].thumbnail.width, 498);
	assert.ok(observed.cases[0].thumbnail.rgb[1] > 250);
	assert.equal(observed.versions.fluentFfmpeg, '2.1.3');
	assert.equal(observed.cleanup, true);
	assert.deepEqual(observed.processFailure, { rejects: true, cleanup: true });
});
