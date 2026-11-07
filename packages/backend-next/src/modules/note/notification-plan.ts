/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { PostNotificationType } from '../notification/public.js';

export interface NoteNotificationPlanInput {
	id: string;
	userId: string;
	channelId?: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	visibleUserIds: string[];
	mentions: string[];
	threadId?: string;
	replyThreadId?: string;
	reply: { id: string; userId: string } | null;
	renote: { id: string; userId: string } | null;
	pureRenote: boolean;
	localUserIds: ReadonlySet<string>;
	threadMutedUserIds: ReadonlySet<string>;
	subscribers: { userId: string; renoteMuted: boolean }[];
}

export interface PlannedNoteNotification {
	recipientId: string;
	type: Exclude<PostNotificationType, 'pollEnded'>;
	targetNoteId: string | null;
}

export function planNoteNotifications(note: NoteNotificationPlanInput): PlannedNoteNotification[] {
	const result: PlannedNoteNotification[] = [];
	if (note.reply === null && note.visibility !== 'specified') {
		for (const subscriber of note.subscribers) {
			if (subscriber.userId !== note.userId && !(note.pureRenote && subscriber.renoteMuted)) {
				result.push({ recipientId: subscriber.userId, type: 'note', targetNoteId: null });
			}
		}
	}
	const manager = new Map<string, PlannedNoteNotification>();
	const push = (recipientId: string, type: PlannedNoteNotification['type']) => {
		if (recipientId !== note.userId && note.localUserIds.has(recipientId)) {
			manager.set(recipientId, { recipientId, type, targetNoteId: type === 'renote' ? note.renote!.id : null });
		}
	};
	for (const recipientId of note.mentions) {
		if (!note.threadMutedUserIds.has(recipientId)) {
			push(recipientId, 'mention');
		}
	}
	if (note.reply !== null && !note.threadMutedUserIds.has(note.reply.userId)) {
		push(note.reply.userId, 'reply');
	}
	if (note.renote !== null) {
		push(note.renote.userId, note.pureRenote ? 'renote' : 'quote');
	}
	for (const notification of manager.values()) {
		// 本家は followers の非フォロワー宛てを除外しない。specified だけをここで絞る。
		if (note.visibility !== 'specified' || note.visibleUserIds.includes(notification.recipientId)) {
			result.push(notification);
		}
	}
	return result;
}
