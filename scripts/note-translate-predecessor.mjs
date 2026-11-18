/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const transitions = {
  "packages/backend-next/src/composition/note-routes.ts": {
    "current": "acc54edcb294f989c41d2a3680587e4f0789d3edef3900b840a9c084269ee353",
    "previous": "2f7242d5d7b5ffcaf03a505c1ceabc2fedb1588bf88b49a1bc4ddbdf77e11b2a",
    "additions": [
      "import { createNoteTranslateHttp } from './note-translate-http.js';\n",
      "translation: createNoteTranslateHttp(resources, config), ",
      "\n\t\t.route('/', prepared.translation)"
    ]
  },
  "packages/backend-next/test/unit/composition/http-app.test.ts": {
    "current": "e4121be82e17d7f1113f43a69e4b78b7a38c1d3d67c08ad8e36eed7995f36f2f",
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
