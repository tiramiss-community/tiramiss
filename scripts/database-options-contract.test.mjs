/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectDatabaseDiagnosticsInput } from './database-diagnostics-predecessor.mjs';
import { projectParallelInput } from './parallel-inputs.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectDatabaseReplicationFinalInput } from './database-replication-final-predecessor.mjs';
import { projectDatabaseReplicationRuntimeInput } from './database-replication-runtime-predecessor.mjs';
import { projectDatabaseReplicationInput } from './database-replication-predecessor.mjs';
import { projectDatabaseOptionsInput } from './database-options-predecessor.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = JSON.parse(read('docs/superpowers/compatibility/database-options/compatibility-predecessor.json'));

test('database compatibility changes preserve exact historical inputs without accepting unmeasured drift', () => {
	assert.equal(record.baseline, 'fe1a8106c3b3d5aba8ddf57de5e28e37e4e0e6ca');
	for (const [path, binding] of Object.entries(record.files)) {
		const bytes = projectDatabaseReplicationInput(path, read(path));
		assert.equal(sha(bytes), binding.currentSha256, path);
		assert.equal(sha(projectDatabaseOptionsInput(path, bytes)), binding.previousSha256, path);
		const drift = Buffer.concat([bytes, Buffer.from('\n')]);
		assert.equal(projectDatabaseOptionsInput(path, drift), drift);
	}
});


test('measured replica input preserves its exact predecessor while fresh drift remains visible', () => {
	const replica = JSON.parse(read('docs/superpowers/compatibility/database-options/replication-predecessor.json'));
	const measured = JSON.parse(read('docs/superpowers/compatibility/database-options/replication-results.json'));
	for (const [path, binding] of Object.entries(replica.files)) {
		const actual = projectDatabaseReplicationRuntimeInput(path, read(path));
		assert.equal(sha(actual), binding.currentSha256);
		assert.equal(measured.inputs[path], binding.currentSha256);
		assert.equal(sha(projectDatabaseReplicationInput(path, actual)), binding.previousSha256);
		assert.equal(sha(projectDatabaseOptionsInput(path, actual)), record.files[path].previousSha256);
		const drift = Buffer.concat([actual, Buffer.from('\n')]);
		assert.equal(projectDatabaseReplicationInput(path, drift), drift);
		assert.equal(projectDatabaseOptionsInput(path, drift), drift);
	}
	const unrelated = Buffer.from('unrelated current bytes');
	assert.equal(projectDatabaseReplicationInput('unrelated', unrelated), unrelated);
});


test('measured post-save and failed-initialization fixes preserve exact predecessors without accepting later drift', () => {
	const runtime = JSON.parse(read('docs/superpowers/compatibility/database-options/replication-runtime-predecessor.json'));
	const measured = JSON.parse(read('docs/superpowers/compatibility/database-options/replication-review-results.json'));
	for (const [path, binding] of Object.entries(runtime.files)) {
		const actual = projectDatabaseReplicationFinalInput(path, read(path));
		assert.equal(sha(actual), binding.currentSha256, path);
		assert.equal(measured.inputs[path], binding.currentSha256, path);
		assert.equal(sha(projectDatabaseReplicationRuntimeInput(path, actual)), binding.previousSha256, path);
		const drift = Buffer.concat([actual, Buffer.from('\n')]);
		assert.equal(projectDatabaseReplicationRuntimeInput(path, drift), drift);
		assert.equal(projectDatabaseOptionsInput(path, drift), drift);
	}
});


test('per-query primary reads and initialization ownership keep exact prior inputs and reject future drift', () => {
	const final = JSON.parse(read('docs/superpowers/compatibility/database-options/replication-final-predecessor.json'));
	const measured = JSON.parse(read('docs/superpowers/compatibility/database-options/replication-final-results.json'));
	for (const [path, binding] of Object.entries(final.files)) {
		const actual = projectDatabaseDiagnosticsInput(path, read(path));
		assert.equal(sha(actual), binding.currentSha256, path);
		assert.equal(measured.inputs[path], binding.currentSha256, path);
		assert.equal(sha(projectDatabaseReplicationFinalInput(path, actual)), binding.previousSha256, path);
		const drift = Buffer.concat([actual, Buffer.from('\n')]);
		assert.equal(projectDatabaseReplicationFinalInput(path, drift), drift);
		assert.equal(projectDatabaseOptionsInput(path, drift), drift);
	}
});


test('slow-query diagnostic wiring retains exact prior inputs without hiding further drift', () => {
	const diagnostics = JSON.parse(read('docs/superpowers/compatibility/database-options/diagnostics-predecessor.json'));
	const measured = JSON.parse(read('docs/superpowers/compatibility/database-options/diagnostics-results.json'));
	assert.equal(diagnostics.baseline, '706f82eb2086c7364001d770ffde73000911bd07');
	for (const [path, binding] of Object.entries(diagnostics.files)) {
		const actual = projectParallelInput(path, read(path), binding.currentSha256);
		assert.equal(sha(actual), binding.currentSha256, path);
		assert.equal(measured.inputs[path], binding.currentSha256, path);
		assert.equal(sha(projectDatabaseDiagnosticsInput(path, actual)), binding.previousSha256, path);
		const drift = Buffer.concat([actual, Buffer.from('\n')]);
		assert.equal(projectDatabaseDiagnosticsInput(path, drift), drift);
		assert.equal(projectDatabaseOptionsInput(path, drift), drift);
	}
	const unrelated = Buffer.from('unrelated current bytes');
	assert.equal(projectDatabaseDiagnosticsInput('unrelated', unrelated), unrelated);
});
