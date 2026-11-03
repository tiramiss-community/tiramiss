/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readNotePlan } from './read-plan.js';
import { renderNote } from './render-note.js';
import type { NoteFactsReader } from './model.js';

export class NoteReadError extends Error {
	constructor(public readonly code: 'NO_SUCH_NOTE' | 'CONTENT_RESTRICTED_BY_USER' | 'CONTENT_RESTRICTED_BY_SERVER') {
		super(code);
	}
}

export function createShowNote(reader: NoteFactsReader) {
	return { async showNote(id: string, viewerId: string | null, now: number) {
		const [root] = await reader.readNotes([id]);
		if (!root) {
			throw new NoteReadError('NO_SUCH_NOTE');
		}
		if (viewerId === null) {
			const access = await reader.readGuestAccess(root);
			if (access.authorRequiresSignin) {
				throw new NoteReadError('CONTENT_RESTRICTED_BY_USER');
			}
			if (access.ugcVisibilityForVisitor === 'none' || (access.ugcVisibilityForVisitor === 'local' && root.userHost !== null)) {
				throw new NoteReadError('CONTENT_RESTRICTED_BY_SERVER');
			}
		}
		const notes = await readNotePlan([id], ids => ids.length === 1 && ids[0] === id ? Promise.resolve([root]) : reader.readNotes(ids));
		const materials = await reader.readMaterials(notes, viewerId, now);
		return renderNote(id, materials, viewerId, now);
	} };
}
