/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { AuthorFacts, NoteFacts } from './model.js';

export function hiddenByTime(threshold: number | null, createdAt: number, now: number): boolean {
	if (threshold === null) {
		return false;
	}
	return threshold <= 0 ? now - createdAt >= Math.abs(threshold) * 1000 : createdAt <= threshold * 1000;
}

export function noteVisibility(note: NoteFacts, author: AuthorFacts, now: number): NoteFacts['visibility'] {
	return (note.visibility === 'public' || note.visibility === 'home') && hiddenByTime(author.makeNotesFollowersOnlyBefore, note.createdAtMs, now)
		? 'followers' : note.visibility;
}

export function shouldHideNote(note: NoteFacts, author: AuthorFacts, viewerId: string | null, options: {
	visibility: NoteFacts['visibility']; replyAuthorId?: string; isFollowing: boolean; visitorsAllowed: boolean; now: number;
}): boolean {
	if (viewerId === note.userId) {
		return false;
	}
	if (viewerId === null && (!options.visitorsAllowed || author.requireSigninToViewContents)) {
		return true;
	}
	if (hiddenByTime(author.makeNotesHiddenBefore, note.createdAtMs, options.now)) {
		return true;
	}
	if (options.visibility === 'specified') {
		return viewerId === null || !note.visibleUserIds.includes(viewerId);
	}
	if (options.visibility === 'followers') {
		return viewerId === null || !(options.replyAuthorId === viewerId || note.mentions.includes(viewerId) || options.isFollowing);
	}
	return false;
}

// 作成対象の可視性と出力のhiddenは、本家でも別の判定を使う。
export function isVisibleForViewer(note: NoteFacts, viewer: { id: string; host: string | null } | null, following: boolean): boolean {
	if (note.visibility === 'specified') {
		return viewer !== null && (viewer.id === note.userId || note.visibleUserIds.includes(viewer.id));
	}
	if (note.visibility === 'followers') {
		return viewer !== null && (viewer.id === note.userId || viewer.id === note.replyUserId || note.mentions.includes(viewer.id)
			|| following || (note.userHost !== null && viewer.host !== null));
	}
	return true;
}
