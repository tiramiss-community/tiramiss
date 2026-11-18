/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectPromoReadInput } from './promo-read-predecessor.mjs';
import { projectNoteTranslationInput } from './note-translate-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = readFileSync(new URL('../docs/superpowers/compatibility/promo/compatibility-predecessor.json', import.meta.url));
assert.equal(sha(record), 'e1305fb12f8ea8f2a5ac5856ab47f5ad0cab2ec9a52a89ff42cba472f2dfd089', 'promo predecessor seal');
const { files } = JSON.parse(record);

// Preserve earlier measurements through only the exact additive #542 inputs.
export function projectPromoInput(path, actual) {
	actual = projectNoteTranslationInput(path, projectPromoReadInput(path, actual));
	const binding = Object.hasOwn(files, path) ? files[path] : undefined;
	if (!binding || sha(actual) !== binding.currentSha256) return actual;
	let before = Buffer.from(actual);
	for (const patch of [...binding.patches].reverse()) {
		const inserted = Buffer.from(patch.insert);
		assert.deepEqual(before.subarray(patch.offset, patch.offset + inserted.length), inserted, 'promo predecessor anchor');
		before = Buffer.concat([before.subarray(0, patch.offset), Buffer.from(patch.previous), before.subarray(patch.offset + inserted.length)]);
	}
	assert.equal(sha(before), binding.previousSha256, 'promo predecessor identity');
	return before;
}
