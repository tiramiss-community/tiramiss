/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { matchesWords } from './keywords.js';
import type { NotePostSaveInput } from './create-contract.js';

export interface HashtagMention { tag: string; userId: string; userHost: string | null }
export interface HashtagRankingSettings { hiddenTags: string[]; sensitiveWords: string[] }

export function planNoteHashtags(input: NotePostSaveInput): HashtagMention[] {
	if (!input.createdSnapshot) {
		throw new Error('NOTE_HASHTAG_SNAPSHOT_MISSING');
	}
	const note = input.createdSnapshot.note;
	if (note.visibility !== 'public' && note.visibility !== 'home') {
		return [];
	}
	return note.tags.map(tag => ({ tag: tag.normalize('NFKC').toLowerCase(), userId: note.userId, userHost: note.userHost }));
}

export function canRankHashtag(tag: string, settings: HashtagRankingSettings): boolean {
	const normalized = tag.normalize('NFKC').toLowerCase();
	return !settings.hiddenTags.some(hidden => hidden.normalize('NFKC').toLowerCase() === normalized) && !matchesWords(normalized, settings.sensitiveWords);
}
