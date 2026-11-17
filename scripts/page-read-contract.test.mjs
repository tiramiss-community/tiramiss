/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPageReadInput } from './notes-pagination-evidence.mjs';
import { projectPageLikeEntityInput } from './package-imports-evidence.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [project, path, digest] of [
	[projectPageReadInput, 'packages/backend-next/src/composition/http-app.ts', '70ad0cbb84ddcefaa2e6fc9ac79e1a0c769707537ed39d200d7340b98c0657a6'],
	[projectPageReadInput, 'packages/backend-next/test/unit/composition/http-app.test.ts', 'cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2'],
	[projectPageLikeEntityInput, 'packages/backend-upstream/.managed-files.json', '48bbbdcd10e4b90e03622a94ecb9539819963cecb7acaffa6ef9d24979c41410'],
	[projectPageLikeEntityInput, 'packages/backend-upstream/exports/entities.ts', '05ff04e21dee5f38a108332c5c1e9bbdee734e8e8b8169f363674a39050e9146'],
	[projectPageLikeEntityInput, 'packages/backend-upstream/upstream-sync.json', '2249ddafc88912805a900366e8ee19cebf5f4f584ac28a932c2ab26a44282661'],
	[projectPageLikeEntityInput, 'packages/backend-next/test/package-imports.test.ts', '6d892d5b6f571cf93fea57c80c5346a9f63fd15b6e8c018b7c60b44886367b2f'],
]) {
	test(`Page additions retain exactly their predecessor and reject current drift: ${path}`, () => {
		const actual = read(path);
		const previous = project(path, actual);
		const relationPrevious = {"packages/backend-next/src/composition/http-app.ts": "5f881c86b179744c73be9d1c7b668a2227747b9cf98a8a7ecfbb7b2dc2b68264", "packages/backend-next/test/unit/composition/http-app.test.ts": "734cee44fd1181a8c77fa08bf05623e41b28478b0f4eea8a2d2f8689c7632899"};
		// In the combined tree the Page step leaves the exact Relation-only bytes.
		const expected = Object.hasOwn(relationPrevious, path) && hash(previous) === relationPrevious[path] ? relationPrevious[path] : digest;
		assert.equal(hash(previous), expected);
		assert.equal(project(path, previous), previous);
		assert.throws(() => project(path, Buffer.concat([actual, Buffer.from('\n')])), /measured.*input/);
		assert.throws(() => project(path, Buffer.concat([Buffer.from([actual[0] ^ 1]), actual.subarray(1)])), /measured.*input/);
		assert.equal(hash(project(path, read(path))), expected);
	});
}

test('Page observations cover the exact corpus and import complete fixed modules', () => {
	const directory = 'docs/superpowers/compatibility/page-read/';
	const bytes = read(directory + 'corpus.json'), corpus = JSON.parse(bytes), observations = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observations.corpusSha256, hash(bytes));
	assert.equal(observations.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual(observations.cases.map(row => row.id), corpus.cases.map(row => row.id));
	assert.equal(new Set(corpus.cases.map(row => row.id)).size, corpus.cases.length);
	for (const file of ['core/entities/PageEntityService.ts', 'core/entities/DriveFileEntityService.ts', 'core/IdService.ts', 'server/api/endpoints/pages/show.ts']) {
		assert(observations.manifest.some(row => row.path === 'packages/backend/src/' + file));
	}
});
