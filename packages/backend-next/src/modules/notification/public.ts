/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type PostNotificationType = 'reply' | 'mention' | 'quote' | 'renote' | 'note';

/** Reception conditions, identifiers and time are decided by the calling use case. */
export interface PostNotification {
	id: string;
	recipientId: string;
	type: PostNotificationType;
	notifierId: string;
	noteId: string;
	targetNoteId: string | null;
	createdAtMs: number;
}
