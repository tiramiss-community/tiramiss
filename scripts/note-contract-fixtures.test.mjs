/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../docs/superpowers/compatibility/note/', import.meta.url);
const read = file => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
const inputs = read('http-cases.json');
const observations = read('observations.json');

test('C1–C10/F1–F8 keep concrete evidence and an implementation owner', () => {
	const coverage = read('coverage.json');
	// This measured dataset stays pinned when backend-upstream advances.
	assert.equal(coverage.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual(coverage.cases.map(entry => entry.id), [...Array.from({ length: 10 }, (_, i) => `C${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `F${i + 1}`)]);
	for (const entry of coverage.cases) {
		assert.ok(entry.owners.length > 0, entry.id);
		assert.ok(entry.remaining.length > 0, entry.id);
		assert.ok(entry.upstream.length > 0, entry.id);
		for (const evidence of entry.evidence) {
			const file = read(evidence.file);
			assert.ok(Object.hasOwn(file, evidence.key), `${entry.id}: missing ${evidence.key}`);
		}
		if (entry.status === 'measured') {
			assert.ok(entry.evidence.length > 0, entry.id);
		} else {
			assert.equal(entry.status, 'new-design-contract', entry.id);
		}
	}
});

test('every shared HTTP input has a response and rejection leaves Note/Poll unchanged', () => {
	assert.equal(new Set(inputs.map(entry => entry.id)).size, inputs.length);
	for (const entry of inputs) {
		const result = observations[entry.id];
		assert.ok(result, entry.id);
		assert.ok([200, 400, 401, 403, 429].includes(result.status), entry.id);
		if (result.status >= 400) {
			assert.deepEqual(result.delta, { notes: 0, polls: 0 }, entry.id);
			assert.match(result.body.error.id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
			assert.equal(typeof result.body.error.code, 'string');
			assert.equal(typeof result.body.error.message, 'string');
			assert.ok(['client', 'permission'].includes(result.body.error.kind));
		}
	}
});

test('hidden/detail goldens retain null, omission and viewer-specific fields', () => {
	for (const visibility of ['followers', 'specified']) {
		const hidden = observations[`C5-${visibility}-outsider`].body;
		assert.equal(hidden.text, null);
		assert.equal(hidden.cw, null);
		assert.deepEqual(hidden.fileIds, []);
		assert.deepEqual(hidden.files, []);
		assert.equal(hidden.isHidden, true);
		assert.equal(Object.hasOwn(hidden, 'poll'), false);
		assert.equal(Object.hasOwn(hidden, 'visibleUserIds'), false);
		assert.equal(observations[`C5-${visibility}-bob`].body.poll.choices.length, 2);
	}
	assert.ok(Object.hasOwn(observations['C5-detail-self'].body, 'myReaction'));
	assert.equal(Object.hasOwn(observations['C5-detail-other'].body, 'myReaction'), false);
	for (const file of observations['C3-file-precedence'].body.createdNote.files) {
		assert.equal(file.md5, '0'.repeat(32));
	}
});

test('AP evidence is real HTTP and intentional differences remain separate from upstream results', () => {
	assert.equal(JSON.stringify(observations).includes('http://127.0.0.1:61167/'), false, 'generated origin URLs remain, including HTML links');
	for (const key of ['C9-public', 'C9-home', 'C9-followers', 'C9-specified', 'C9-pure', 'C9-quote', 'C10-Delete', 'C10-Undo', 'C10-fallback', 'F8-upstream-home', 'F8-upstream-followers', 'F8-upstream-specified']) {
		assert.ok(observations[key].length > 0, key);
		for (const receipt of observations[key]) {
			assert.match(receipt.path, /^\/inbox\//);
			assert.equal(receipt.signed, true);
			assert.equal(receipt.digest, true);
		}
	}
	assert.deepEqual(observations['C9-localOnly'], { deliveries: [] });
	const differences = read('intentional-differences.json');
	assert.deepEqual(differences.map(entry => entry.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
	for (const entry of differences) {
		assert.ok(entry.owners.length > 0);
		assert.equal(entry.newImplementationVerified, false);
	}
	const rate = read('rate-observations.json');
	assert.equal(rate['C2-rate-before-input'].status, 429);
	assert.equal(rate['C2-rate-before-input'].body.error.info.resetMs, '$future-epoch-milliseconds');
});
