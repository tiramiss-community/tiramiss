/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type SearchScope = 'local' | 'global' | readonly string[];
export interface SearchNote {
	id: string; userId: string; userHost: string | null; channelId: string | null;
	text: string | null; cw: string | null; tags: string[]; visibility: string;
}
export interface SearchDocument extends Omit<SearchNote, 'visibility'> { createdAt: number }

export function shouldUnindex(visibility: string): boolean {
	return visibility === 'public' || visibility === 'home';
}
export function searchDocument(note: SearchNote, scope: SearchScope, createdAtFromId: (id: string) => number): SearchDocument | null {
	if (!shouldUnindex(note.visibility) || (note.text === null && note.cw === null)) {
		return null;
	}
	if (note.userHost !== null && scope !== 'global' && !(Array.isArray(scope) && scope.includes(note.userHost))) {
		return null;
	}
	return { id: note.id, createdAt: createdAtFromId(note.id), userId: note.userId, userHost: note.userHost, channelId: note.channelId, cw: note.cw, text: note.text, tags: [...note.tags] };
}
