/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type PostNotificationType = 'reply' | 'mention' | 'quote' | 'renote' | 'note' | 'pollEnded';

/** Reception conditions, identifiers and time are decided by the calling use case. */
export interface PostNotification {
	id: string;
	recipientId: string;
	type: PostNotificationType;
	// 本家は pollEnded だけ通知元なしで作る。それ以外の種類では必ず持つ。
	notifierId: string | null;
	noteId: string;
	targetNoteId: string | null;
	createdAtMs: number;
}

export interface PostNotificationWrites {
	save(notification: PostNotification): Promise<void>;
}
