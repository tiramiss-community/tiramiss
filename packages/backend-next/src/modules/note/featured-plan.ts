/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NotePostSaveInput } from './create-contract.js';

export type FeaturedNoteScore =
	| { kind: 'global'; noteId: string }
	| { kind: 'user'; noteId: string; userId: string }
	| { kind: 'channel'; noteId: string; channelId: string };

/** The count-eligible Renote gate has already excluded self and bot actors at creation. */
export function planRenoteFeatured(input: NotePostSaveInput, facts: { now: number; sample: number; createdAtMs: number }): FeaturedNoteScore[] {
	if (input.renotedNoteId === null || !(facts.sample < 0.3) || !(facts.now - facts.createdAtMs < 259200000)) {
		return [];
	}
	const target = input.createdSnapshot?.renote;
	if (!target || target.replyId !== null) {
		return [];
	}
	if (target.channelId !== null) {
		return [{ kind: 'channel', noteId: target.id, channelId: target.channelId }];
	}
	if (target.visibility !== 'public' || target.userHost !== null) {
		return [];
	}
	return [{ kind: 'global', noteId: target.id }, { kind: 'user', noteId: target.id, userId: target.userId }];
}
