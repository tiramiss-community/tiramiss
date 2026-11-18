/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { projectPromoReadInput } from './promo-read-predecessor.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const transitions = {
  "packages/backend-next/src/composition/http-app.ts": {
    "current": "3747f04e5de5e43d5eda0ac7ef856ce7a369cb818e31d159eb85320a7ee7e08a",
    "previous": "0af728aaf5942450d8066540a1ab83a29b4bc16cdb3ba51ecca3df395c366b7c",
    "additions": [
      "import { createNoteTranslateHttp } from './note-translate-http.js';\n",
      "\n\t\t.route('/', createNoteTranslateHttp(resources, config))"
    ]
  },
  "packages/backend-next/test/unit/composition/http-app.test.ts": {
    "current": "65ab0f8c024f3ee776ce915cb46e459bdb5b69eadf2bc859432a6c9598e53517",
    "previous": "cadc10344ec0024592e4aeb73730d369fe10b53a1de4d4dfa4ef88b1a38e203b",
    "additions": [
      "\t\toutboundHttp: { send: vi.fn() },\n",
      "'/api/notes/translate', ",
      "'notes/translate', "
    ]
  }
};

// Restore only the measured translation registration and its unit fixture.
// Unknown bytes continue to the historical validators' existing drift guards.
export function projectNoteTranslationInput(path, actual) {
	actual = projectPromoReadInput(path, actual);
	const binding = Object.hasOwn(transitions, path) ? transitions[path] : undefined;
	if (!binding || sha(actual) !== binding.current) return actual;
	let before = actual.toString();
	for (const addition of binding.additions) {
		assert.equal(before.split(addition).length, 2, 'note translation exact predecessor anchor');
		before = before.replace(addition, '');
	}
	assert.equal(sha(before), binding.previous, 'note translation exact predecessor identity');
	return Buffer.from(before);
}
