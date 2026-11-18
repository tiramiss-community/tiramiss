/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
		const actual = read(path);
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
