/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type PostNotificationType = 'reply' | 'mention' | 'quote' | 'renote' | 'note';

export interface PostNotificationFacts {
	recipientId: string;
	type: PostNotificationType;
	note: { id: string; authorId: string; renoteId: string | null };
}

/** A candidate is not permission to notify; the caller must re-evaluate reception conditions. */
export type PostNotificationDecision = { status: 'deliver' } | { status: 'suppress'; reason: string };

export interface NotificationEffect {
	requestId: string;
	recipientId: string;
	type: PostNotificationType;
	notificationId: string | null;
	reason: string | null;
}
