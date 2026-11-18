/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const evidence = JSON.parse(read('docs/superpowers/compatibility/moderation-log/evidence.json'));
const observation = JSON.parse(read(evidence.addedObservation.file));

test('finite moderation-log evidence names both callers and preserves execution boundaries', () => {
	assert.deepEqual(evidence.ids, ['moderation-log-type:deleteNote', 'moderation-log-type:updateRole']);
	assert.equal(evidence.issue, 546);
	assert.equal(evidence.inventoryStatus, 'partial');
	assert.equal(evidence.runtimeChanged, false);
	assert.equal(evidence.existingSuitesRerun, false);
	assert.equal(evidence.upstreamFullServerMeasured, false);
	assert.equal(observation.upstreamFullServerMeasured, false);
	assert.equal(observation.revision, evidence.upstreamRevision);
	assert.equal(observation.revision, '8e07cf085adf7009583d234a208e30436f020e26');
	assert.deepEqual(observation.sites, ['packages/backend/src/core/NoteDeleteService.ts:120:deleteNote', 'packages/backend/src/core/RoleService.ts:713:updateRole']);
	assert.equal(evidence.addedObservation.provenance, 'literal-source-methods-with-repository-and-id-doubles');
	assert.equal(evidence.addedObservation.provenance, observation.provenance);
	assert(evidence.historicalRecords.every(record => record.measurementTransferredToCurrentHead === false));
	assert(evidence.knownBoundaries.some(boundary => boundary.id === 'author-lookup-before-versus-after-delete' && boundary.owner === 194 && boundary.disposition.includes('decision-open')));
});

test('the recorded observation and named caller assertions remain linked', () => {
	for (const [path, expected] of Object.entries(evidence.observationArtifacts)) {
		assert.equal(createHash('sha256').update(read(path)).digest('hex'), expected, `added observation artifact: ${path}`);
	}
	for (const [path, expected] of Object.entries(observation.currentInputs)) {
		assert.equal(evidence.inspectedInputs[path], expected, `observation input: ${path}`);
	}
	assert.equal(evidence.bindings.length, 13);
	for (const binding of evidence.bindings) {
		assert.equal(binding.executedFor546, false);
		assert(read(binding.file).includes(`'${binding.title}'`), `missing test declaration: ${binding.title}`);
	}
	for (const binding of evidence.entrypointBindings) {
		assert(read(binding.file).includes(binding.assertion), `caller assembly drift: ${binding.file}`);
	}
	for (const [path, record] of Object.entries(evidence.historicalByteComparison)) {
		assert.equal(record.currentSha256, evidence.inspectedInputs[path]);
		assert.equal(record.unchanged, record.historicalSha256 === record.currentSha256);
	}
});

test('historical input hashes match their immutable revisions when history is available', t => {
	const historicalRevision = evidence.historicalRecords[0].implementationCommit;
	const revisions = [evidence.inspectedSourceRevision, historicalRevision];
	if (revisions.some(revision => spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: root }).status !== 0)) {
		assert.equal(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim(), 'true', 'missing provenance revision in full checkout');
		t.skip('shallow checkout lacks historical objects; live semantic checks still run');
		return;
	}
	const historicalHash = (revision, path) => createHash('sha256').update(execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).digest('hex');
	for (const [path, expected] of Object.entries(evidence.inspectedInputs)) {
		assert.equal(historicalHash(evidence.inspectedSourceRevision, path), expected, `inspected revision: ${path}`);
	}
	for (const [path, record] of Object.entries(evidence.historicalByteComparison)) {
		assert.equal(historicalHash(historicalRevision, path), record.historicalSha256, `historical revision: ${path}`);
	}
});

test('the added source observation retains whole finite info and author/time limitations', () => {
	assert.deepEqual(Object.keys(observation.deleteInfo).sort(), ['note', 'noteId', 'noteUserHost', 'noteUserId', 'noteUserUsername'].sort());
	assert.equal(observation.deleteInfo.noteUserHost, 'remote.example');
	assert.deepEqual(observation.deleteInfo.note.nested.list, [null, true]);
	assert.equal(observation.roleInfo.before.updatedAt, '2026-11-17T23:59:59.000Z');
	assert.equal(observation.roleInfo.after.updatedAt, '2026-11-18T00:00:00.000Z');
	assert.deepEqual(observation.boundaries.sourceIdArguments, [[], []]);
	assert.equal(observation.boundaries.nextIdArgument, Date.parse('2026-11-18T00:00:00Z'));
	assert.equal(observation.boundaries.authorLookupProjectionIsDoubleControlled, true);
	assert.notEqual(observation.boundaries.authorLookupProjection.sourcePostDeleteUsername, observation.boundaries.authorLookupProjection.nextPreDeleteSnapshotUsername);
});
