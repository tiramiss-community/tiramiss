/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPromoInput } from './promo-predecessor.mjs';
import { projectWellKnownInput } from './well-known-predecessor.mjs';

const read = path => projectPromoInput(path, readFileSync(new URL('../' + path, import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = JSON.parse(read('docs/superpowers/compatibility/well-known/compatibility-predecessor.json'));

test('well-known transition preserves exactly two old composition inputs while retaining live drift guards', () => {
	assert.equal(record.baseline, 'e045cf2e703e4483cda6b823f8a5d7efde436ab5');
	assert.deepEqual(Object.keys(record.files), [
		'packages/backend-next/src/composition/webfinger-http.ts',
		'packages/backend-next/test/unit/composition/http-app.test.ts',
	]);
	for (const [path, binding] of Object.entries(record.files)) {
		const bytes = read(path);
		assert.equal(sha(bytes), binding.currentSha256, path);
		assert.equal(sha(projectWellKnownInput(path, bytes)), binding.previousSha256, path);
		const drift = Buffer.concat([bytes, Buffer.from('\n')]);
		assert.equal(projectWellKnownInput(path, drift), drift);
		assert.equal(sha(projectWellKnownInput(path, read(path))), binding.previousSha256);
	}
	const unrelated = Buffer.from('unchanged');
	assert.equal(projectWellKnownInput('unrelated', unrelated), unrelated);
});
