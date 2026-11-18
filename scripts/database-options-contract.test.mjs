/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectDatabaseOptionsInput } from './database-options-predecessor.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = JSON.parse(read('docs/superpowers/compatibility/database-options/compatibility-predecessor.json'));

test('database compatibility changes preserve exact historical inputs without accepting unmeasured drift', () => {
	assert.equal(record.baseline, 'fe1a8106c3b3d5aba8ddf57de5e28e37e4e0e6ca');
	for (const [path, binding] of Object.entries(record.files)) {
		const bytes = read(path);
		assert.equal(sha(bytes), binding.currentSha256, path);
		assert.equal(sha(projectDatabaseOptionsInput(path, bytes)), binding.previousSha256, path);
		const drift = Buffer.concat([bytes, Buffer.from('\n')]);
		assert.equal(projectDatabaseOptionsInput(path, drift), drift);
	}
});
