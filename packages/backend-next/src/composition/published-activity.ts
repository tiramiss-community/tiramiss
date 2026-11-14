/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { isPureRenote, renderNoteActivity } from '../modules/federation/public.js';
import { preparePublishedNote } from './published-note.js';
import type { NotePublicationReader, NotePublicationRow } from '../modules/federation/public.js';

export async function preparePublishedActivity(row: NotePublicationRow, reader: NotePublicationReader, options: Parameters<typeof preparePublishedNote>[2]): Promise<Record<string, unknown>> {
	if (!isPureRenote(row)) {
		return renderNoteActivity(await preparePublishedNote(row, reader, options, false), options, false);
	}
	const renote = await reader.readNote(row.renoteId!);
	if (renote === null) {
		throw new Error('publication Renote target is gone');
	}
	// Announce needs no Note/mention/media preparation; its target read is mandatory for public GET.
	return renderNoteActivity({
		note: { ...row, createdAtMs: options.createdAtFromId(row.id), mentionedRemoteUsers: [] },
		renote, reply: null, mentionedUsers: [], files: [], poll: null, emojis: [],
	}, options, false);
}
