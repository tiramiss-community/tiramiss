/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectPromoInput } from './promo-predecessor.mjs';
import { projectNoteTranslationInput } from './note-translate-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/well-known/compatibility-predecessor.json', import.meta.url));
assert.equal(sha(record), '2be832c143111d84669443b08195952a25f43156d8eb189fde0b23e6fafd866d', 'well-known predecessor seal');
const { files } = JSON.parse(record);

// Preserve old measurements through only these exact two composition changes.
// Unknown bytes still reach the existing historical validators' drift guards.
export function projectWellKnownInput(path, actual) {
	actual = projectPromoInput(path, projectNoteTranslationInput(path, actual));
	if (!Object.hasOwn(files, path)) {
		return actual;
	}
	const binding = files[path];
	if (sha(actual) !== binding.currentSha256) {
		return actual;
	}
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const insert = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + insert.length), insert);
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + insert.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'well-known predecessor identity');
	return before;
}
