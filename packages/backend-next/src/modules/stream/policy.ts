/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { hiddenByTime } from '../note/public.js';

export interface StreamNote extends Record<string, unknown> {
	id: string;
	createdAt: string;
	userId: string;
	user: { id: string; host?: string | null; requireSigninToViewContents?: boolean; makeNotesHiddenBefore?: number | null };
	visibility: string;
	text: string | null;
	cw?: string | null;
	visibleUserIds?: string[];
	mentions?: string[];
	fileIds?: string[];
	hasPoll?: boolean;
	reply?: StreamNote | null;
	renote?: StreamNote | null;
	renoteId?: string | null;
	channelId?: string;
	reactions?: Record<string, number>;
}

export interface StreamFacts {
	userId: string | null;
	following: Map<string, { withReplies: boolean }>;
	followingChannels: Set<string>;
	mutedChannels: Set<string>;
	mutedUsers: Set<string>;
	blockingUsers: Set<string>;
	renoteMutedUsers: Set<string>;
	mutedInstances: Set<string>;
	ugcVisibilityForVisitor: string;
}

export function emptyStreamFacts(userId: string | null): StreamFacts {
	return { userId, following: new Map(), followingChannels: new Set(), mutedChannels: new Set(), mutedUsers: new Set(), blockingUsers: new Set(), renoteMutedUsers: new Set(), mutedInstances: new Set(), ugcVisibilityForVisitor: 'public' };
}

export function noteVisible(note: StreamNote, facts: StreamFacts): boolean {
	const me = facts.userId;
	if (note.visibility === 'specified') {
		return me !== null && (me === note.userId || (note.visibleUserIds?.includes(me) ?? false));
	}
	if (note.visibility === 'followers') {
		return me !== null && (me === note.userId || me === note.reply?.userId || (note.mentions?.includes(me) ?? false) || facts.following.has(note.userId));
	}
	return true;
}

export function pureRenote(note: StreamNote): boolean {
	return note.renoteId != null && note.text == null && note.cw == null && (note.fileIds?.length ?? 0) === 0 && note.replyId == null && note.poll == null;
}

export function instanceMuted(note: StreamNote, facts: StreamFacts): boolean {
	return [note, note.reply, note.renote].some(n => facts.mutedInstances.has(n?.user?.host ?? ''));
}

export function noteMuted(note: StreamNote, facts: StreamFacts): boolean {
	const related = [note.userId, note.replyUserId ?? note.reply?.userId, note.renoteUserId ?? note.renote?.userId];
	return instanceMuted(note, facts)
		|| related.some(id => typeof id === 'string' && (facts.mutedUsers.has(id) || facts.blockingUsers.has(id)))
		|| (pureRenote(note) && facts.renoteMutedUsers.has(note.user.id))
		|| [note.channelId, note.renote?.channelId].some(id => id != null && facts.mutedChannels.has(id));
}

export function filterHomeNote(note: StreamNote, facts: StreamFacts, params: Record<string, unknown>): boolean {
	if (facts.userId === null) {
		return false;
	}
	const me = note.userId === facts.userId;
	if (params.withFiles && !note.fileIds?.length) {
		return false;
	}
	if (note.channelId ? !facts.followingChannels.has(note.channelId) : !me && !facts.following.has(note.userId)) {
		return false;
	}
	if (!noteVisible(note, facts)) {
		return false;
	}
	const unfollowedPrivateReply = (reply: StreamNote) => reply.visibility === 'followers' && !facts.following.has(reply.userId) && reply.userId !== facts.userId;
	if (note.reply) {
		if (facts.following.get(note.userId)?.withReplies) {
			if (unfollowedPrivateReply(note.reply)) {
				return false;
			}
		} else if (note.reply.userId !== facts.userId && !me && note.reply.userId !== note.userId) {
			return false;
		}
	}
	if (pureRenote(note) && note.renote) {
		if (!(params.withRenotes ?? true) || (note.renote.reply && unfollowedPrivateReply(note.renote.reply))) {
			return false;
		}
	}
	return !noteMuted(note, facts);
}

function shouldHide(note: StreamNote, facts: StreamFacts, now: number): boolean {
	if (facts.userId === note.userId) {
		return false;
	}
	return (facts.userId === null && (facts.ugcVisibilityForVisitor === 'none' || !!note.user.requireSigninToViewContents))
		|| hiddenByTime(note.user.makeNotesHiddenBefore ?? null, Date.parse(note.createdAt), now)
		|| !noteVisible(note, facts);
}

function hide(note: StreamNote): void {
	delete note.visibleUserIds;
	delete note.poll;
	Object.assign(note, { fileIds: [], files: [], text: null, cw: null, isHidden: true });
}

export function hideStreamNote(note: StreamNote, facts: StreamFacts, now: number): StreamNote | null {
	if (facts.userId === null && (facts.ugcVisibilityForVisitor === 'none' || (facts.ugcVisibilityForVisitor === 'local' && note.user.host != null))) {
		return null;
	}
	const chain: StreamNote[] = [];
	for (let current: StreamNote | null | undefined = note; current; current = current.renote) {
		chain.push(current);
	}
	const hidden = chain.map(n => shouldHide(n, facts, now));
	if (hidden.some(Boolean) && chain.some(pureRenote)) {
		return null;
	}
	// Each receiver also populates myReaction, so even visible snapshots are private copies.
	const result = structuredClone(note);
	let current = result;
	for (const [i, original] of chain.entries()) {
		if (hidden[i]) {
			hide(current);
		}
		if (original.reply && current.reply && shouldHide(original.reply, facts, now)) {
			hide(current.reply);
		}
		current = current.renote!;
	}
	return result;
}
