/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { apContext } from './ap-context.js';
import type { NoteActivityMaterials, NoteActivityNote, ApDocumentSourceFacts } from './note-activity.js';
/** Saved scalar facts; parsing and related-row reads occur in source order at the composition boundary. */
export interface NotePublicationRow extends Omit<NoteActivityNote, 'createdAtMs' | 'mentionedRemoteUsers'> {
	uri: string | null;
	userHost: string | null;
	localOnly: boolean;
	mentionedRemoteUsers: string;
	mentions: string[];
	emojis: string[];
}
export interface NotePublicationReader {
	readNote(id: string): Promise<NotePublicationRow | null>;
	authorExists(id: string): Promise<boolean>;
	readMentionedUsers(ids: string[]): Promise<NoteActivityMaterials['mentionedUsers']>;
	readFiles(ids: string[]): Promise<ApDocumentSourceFacts[]>;
	readPoll(id: string): Promise<NoteActivityMaterials['poll']>;
	readEmojis(names: string[]): Promise<NoteActivityMaterials['emojis']>;
}
export interface FeaturedReader {
	readLocalUser(id: string): Promise<{
		id: string;
	} | null>;
	readPinNoteIdsDescending(userId: string): Promise<string[]>;
	readPinnedNote(id: string): Promise<NotePublicationRow>;
}
export async function readFeaturedNotes(userId: string, reader: FeaturedReader): Promise<NotePublicationRow[] | null> {
	const user = await reader.readLocalUser(userId);
	if (user === null) {
		return null;
	}
	const ids = await reader.readPinNoteIdsDescending(user.id);
	// A missing pin target must reject before visibility filtering, just as findOneByOrFail does upstream.
	const notes = await Promise.all(ids.map(id => reader.readPinnedNote(id)));
	return notes.filter(note => !note.localOnly && ['public', 'home'].includes(note.visibility));
}
export function renderFeaturedCollection(userId: string, items: Record<string, unknown>[], selfUrl: string): Record<string, unknown> {
	return { '@context': apContext, id: `${selfUrl}/users/${userId}/collections/featured`, type: 'OrderedCollection', totalItems: items.length, orderedItems: items };
}
