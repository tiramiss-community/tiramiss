/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inEvidenceValidationScope } from './evidence-validation-scope.mjs';
import { publicDocumentsPredecessorFiles, readPrePublicDocuments, validatePublicDocumentsEvidence } from './public-documents-evidence.mjs';
import { readForMetaCacheEvidence } from './joint-drive-meta-evidence.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const directory = 'docs/superpowers/compatibility/public-documents/';
const receipt = () => JSON.parse(read(directory + 'current-evidence.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('source observations bind all 51 listening HTTP responses to the fixed corpus', () => {
	const corpus = JSON.parse(read(directory + 'corpus.json'));
	const observations = JSON.parse(read(directory + 'observations.json'));
	assert.equal(observations.upstreamRevision, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(observations.upstreamRevision, corpus.upstreamRevision);
	assert.equal(observations.corpusSha256, sha(read(directory + 'corpus.json')));
	assert.equal(observations.source.sha256, '8915cc056efcf97f930bd538c84bed253a25b2042d22cb259167fb4f686575c4');
	assert.deepEqual(observations.cases.map(item => item.id), corpus.cases.map(item => item.id));
	assert.equal(observations.cases.length, 17);
	assert(observations.cases.every(item => item.responses.length === 3));
	for (const path of ['packages/backend-next/test/unit/public-documents.test.ts', 'packages/backend-next/test/integration/public-documents.test.ts']) {
		const source = read(path).toString();
		assert(source.includes('observations.cases'));
		assert(source.includes('corpus.cases.find'));
	}
});

test('only two changed shared inputs project to exact base bytes after the full current gate', () => {
	const saved = JSON.parse(read(directory + 'predecessor.json'));
	const previous = validatePublicDocumentsEvidence(undefined, read, () => null);
	assert.deepEqual(Object.keys(previous), publicDocumentsPredecessorFiles);
	for (const path of publicDocumentsPredecessorFiles) {
		assert.equal(sha(read(path)), saved.files[path].currentSha256);
		assert.equal(sha(readPrePublicDocuments(path, read, () => null)), saved.files[path].previousSha256);
	}
	assert.equal(readPrePublicDocuments('unrelated', () => Buffer.from('live')).toString(), 'live');
});

for (const path of Object.keys(receipt().inputs)) {
	test(`current drift rejects through direct and historical public readers: ${path}`, () => {
		const drift = file => file === path ? Buffer.concat([read(file), Buffer.from('\n')]) : read(file);
		assert.throws(() => validatePublicDocumentsEvidence(undefined, drift, () => null), /measured current input drift/);
		assert.throws(() => readPrePublicDocuments(publicDocumentsPredecessorFiles[0], drift, () => null), /measured current input drift/);
		assert.throws(() => readForMetaCacheEvidence(publicDocumentsPredecessorFiles[1], drift), /measured current input drift/);
	});
}

test('receipt/predecessor corruption and available log drift reject', () => {
	for (const name of ['current-evidence.json', 'predecessor.json']) {
		assert.throws(() => validatePublicDocumentsEvidence(undefined, path => path === directory + name ? Buffer.from('{}') : read(path), () => null), /seal/);
	}
	const forged = receipt();
	forged.inputCapture = 'forged';
	assert.throws(() => validatePublicDocumentsEvidence(forged, read, () => null), /receipt seal/);
	for (const run of receipt().runs) {
		assert.throws(() => validatePublicDocumentsEvidence(undefined, read, path => path === run.log ? Buffer.from('forged PASS') : null), /actual log drift/);
	}
});

test('later drift, historical bytes supplied as current, and same-scope drift never use stale validation', () => {
	const path = publicDocumentsPredecessorFiles[0];
	let changed = false;
	const reader = file => file === path && changed ? Buffer.from('changed') : read(file);
	readPrePublicDocuments(path, reader, () => null);
	changed = true;
	assert.throws(() => readPrePublicDocuments(path, reader, () => null), /measured current input drift/);
	const previous = validatePublicDocumentsEvidence(undefined, read, () => null);
	assert.throws(() => validatePublicDocumentsEvidence(undefined, file => Object.hasOwn(previous, file) ? Buffer.from(previous[file]) : read(file), () => null), /measured current input drift/);
	changed = false;
	const offline = () => null;
	inEvidenceValidationScope(() => {
		readPrePublicDocuments(path, reader, offline);
		changed = true;
		assert.throws(() => readPrePublicDocuments(path, reader, offline), /measured current input drift/);
	});
});
