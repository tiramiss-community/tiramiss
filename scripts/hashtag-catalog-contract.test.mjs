/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectHashtagCatalogInput, validateHashtagCatalogEvidence } from './hashtag-catalog-evidence.mjs';
import { projectNoteChartsInput, validateNoteChartsEvidence } from './note-charts-evidence.mjs';

const directory = 'docs/superpowers/compatibility/hashtag-catalog/';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const offline = () => null;

test('catalog evidence binds measured inputs and preserves exact old composition bytes', () => {
	const current = validateHashtagCatalogEvidence(read, offline);
	const predecessor = JSON.parse(read(directory + 'predecessor.json'));
	assert.equal(Object.keys(predecessor.files).length, 2);
	for (const [path, binding] of Object.entries(predecessor.files)) {
		assert.equal(current.inputs[path], binding.currentSha256);
		assert.equal(sha(projectHashtagCatalogInput(path, read(path))), binding.previousSha256);
		const drift = Buffer.concat([read(path), Buffer.from('\n')]);
		assert.equal(projectHashtagCatalogInput(path, drift), drift);
		assert.equal(projectNoteChartsInput(path, drift), drift);
	}
	validateNoteChartsEvidence(read, offline);
});

test('catalog current inputs, receipts and available logs cannot drift', () => {
	const current = validateHashtagCatalogEvidence(read, offline);
	for (const path of Object.keys(current.inputs)) {
		assert.throws(() => validateHashtagCatalogEvidence(file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), offline), /measured current input drift/);
	}
	for (const path of Object.keys(current.previousMeasurement.files)) {
		assert.throws(() => validateHashtagCatalogEvidence(file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file), offline), /historical input drift/);
	}
	assert.throws(() => validateHashtagCatalogEvidence(file => file.endsWith('current-evidence.json') ? Buffer.from('{}') : read(file), offline), /receipt seal/);
	const path = Object.keys(JSON.parse(read(directory + 'predecessor.json')).files)[0];
	assert.throws(() => projectHashtagCatalogInput(path, read(path), file => file.endsWith('predecessor.json') ? Buffer.from('{}') : read(file)), /predecessor seal/);
	for (const run of current.runs) {
		assert.throws(() => validateHashtagCatalogEvidence(read, path => path === run.log ? Buffer.from('forged') : null), /actual log drift/);
	}
});

test('fixed source corpus covers every list direction and attached combination with nonvacuous PG observations', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const source = JSON.parse(read(directory + 'observations.json'));
	assert.equal(source.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(source.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.equal(source.manifest.length, 7);
	assert.equal(source.cases.length, 53);
	assert.deepEqual(source.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(corpus.cases.filter(item => item.id.startsWith('sort-')).length, 12);
	assert.equal(corpus.cases.filter(item => item.id.startsWith('attached-filters-')).length, 8);
	assert.equal(new Set(corpus.rows.map(row => row.name)).size, 12);
	assert.deepEqual(source.access, { list: { requireCredential: false }, search: { requireCredential: false }, show: { requireCredential: false } });
	assert.equal(source.cases.find(item => item.id === 'offset--1').error.code, '2201X');
	assert.equal(source.cases.find(item => item.id === 'show-fullwidth').result.tag, 'abc');
	assert.deepEqual(source.cases.find(item => item.id === 'search-fullwidth').result, ['ａｂｃ']);
});

test('unrelated historical paths never read or validate catalog artifacts', () => {
	const bytes = Buffer.from('unrelated');
	assert.equal(projectHashtagCatalogInput('unrelated', bytes, () => {
		throw Error('must not read catalog metadata');
	}), bytes);
});
