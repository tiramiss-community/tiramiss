/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface PostWorkNote {
	visibility: 'public' | 'home' | 'followers' | 'specified';
	localOnly: boolean;
	channelId: string | null;
}

interface PostWorkBase {
	requestId: string;
	eventId: string;
	noteId: string;
	actorId: string;
	note: PostWorkNote;
	noteGeneration: 1 | 2;
	schemaVersion: 1;
	occurredAtMs: number;
	notBeforeMs: number;
}

export interface ApWorkRequest extends PostWorkBase {
	kind: 'ap.expand';
	payload: {
		activity: { id: string; type: 'Create' | 'Announce' | 'Delete' | 'Undo'; body: string };
		directActorIds: readonly string[];
	};
}

export interface NotificationWorkRequest extends PostWorkBase {
	kind: 'notification.create';
	noteGeneration: 1;
	payload: {
		candidates: readonly {
			recipientId: string;
			type: 'reply' | 'mention' | 'quote' | 'renote' | 'note';
		}[];
	};
}

export type PostWorkRequest = ApWorkRequest | NotificationWorkRequest;

export interface PostWorkRequests {
	/** The caller owns the transaction; this operation does not enqueue or commit. */
	append(request: PostWorkRequest): Promise<{ requestId: string }>;
}

export class InvalidPostWorkRequest extends Error {}
export class WorkPayloadTooLarge extends Error {}
export class WorkCapacityExceeded extends Error {}
export class WorkRequestConflict extends Error {}
