/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createShowNote } from '../../../src/modules/note/show-note.js';
import type { NoteFacts, NoteFactsReader } from '../../../src/modules/note/model.js';

test('not found precedes guest restrictions, author precedes server and graph expansion', async () => {
	let root: NoteFacts | undefined = undefined;
	let accessCalls = 0;
	const reader = {
		async readNotes() {
			return root ? [root] : [];
		},
		async readGuestAccess() {
			accessCalls++;
			return { authorRequiresSignin: true, ugcVisibilityForVisitor: 'none' };
		},
		async readMaterials() {
			throw new Error('MATERIALS_MUST_NOT_BE_READ');
		},
	} satisfies NoteFactsReader;
	await expect(createShowNote(reader).showNote('missing', null, 0)).rejects.toThrow('NO_SUCH_NOTE');
	expect(accessCalls).toBe(0);
	root = { id: 'a', renoteId: 'a' } as NoteFacts;
	await expect(createShowNote(reader).showNote('a', null, 0)).rejects.toThrow('CONTENT_RESTRICTED_BY_USER');
});
