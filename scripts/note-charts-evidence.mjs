/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const evidencePath = 'docs/superpowers/compatibility/note-charts/compatibility-predecessor.json';
const seal = '42d3c7a95fda7526edbce733d53cb0d4a014fc25a46ce596bd9fa2381707816e';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const optionalRead = path => { try { return readFileSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function record(readFile) {
	const bytes = readFile(evidencePath);
	assert.equal(sha(bytes), seal, 'note charts evidence seal');
	return JSON.parse(bytes);
}
const evidence = record(read);
export const noteChartPredecessorPaths = Object.freeze(Object.keys(evidence.predecessors));

export function validateNoteChartsEvidence(readFile = read, optional = optionalRead) {
	const current = record(readFile);
	assert.equal(current.runtimeRevision, '773ba79f2fadc7eee8a61fb40975518e283eb446');
	assert.equal(current.baseRevision, 'c0123d10df9c7946a0bd0b65eeb12df7bff80776');
	assert.equal(current.postingComplete, false);
	assert.equal(current.upstreamFullServerMeasured, false);
	for (const [path, digest] of Object.entries(current.currentInputs)) {
		assert.equal(sha(readFile(path)), digest, `note charts measured current input drift: ${path}`);
	}
	const corpus = JSON.parse(readFile('docs/superpowers/compatibility/note-charts/source-observations.json'));
	assert.equal(corpus.upstreamCommit, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.equal(corpus.updates.length, 32, 'note chart producer case count');
	assert.equal(corpus.reads.length, 24, 'note chart cursor case count');
	assert.equal(new Set(corpus.updates.map(row => JSON.stringify([row.series, row.note.userHost, row.additional, row.note.replyId, row.note.renoteId, row.note.fileIds]))).size, 32, 'note chart producer case identities');
	assert.equal(new Set(corpus.reads.map(row => JSON.stringify([row.span, row.limit, row.offset]))).size, 24, 'note chart cursor case identities');
	assert.equal(corpus.reads.filter(row => row.expectedError === 'wrong number of arguments').length, 4, 'note chart epoch projection failures');
	for (const run of current.runs) {
		const bytes = optional(run.log);
		if (bytes !== null) {
			assert.equal(sha(bytes), run.logSha256, 'note charts actual log drift');
		}
	}
	return current;
}

// Only #274's finite byte changes are removed. The archived measurements and their
// original revisions remain historical; current chart behavior has its own runs.
export function projectNoteChartsInput(path, actual) {
	const binding = evidence.predecessors[path];
	if (!binding) return actual;
	const digest = sha(actual);
	// Older layers may already have removed other independently measured additions.
	// Leave those bytes to their own exact guards; project only the current chart input.
	if (digest !== binding.currentSha256) return actual;
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const added = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + added.length), added, 'note charts predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + added.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'note charts predecessor identity');
	return before;
}
