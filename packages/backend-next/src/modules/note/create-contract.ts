/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface NoteCreateActor {
	userId: string;
	canWriteNote: boolean;
}

export interface TextNoteInput {
	text: string;
	cw?: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	localOnly: boolean;
	reactionAcceptance: null | 'likeOnly' | 'likeOnlyForRemote' | 'nonSensitiveOnly' | 'nonSensitiveOnlyForLocalLikeOnlyForRemote';
	visibleUserIds?: string[];
	noExtractMentions?: boolean;
	noExtractHashtags?: boolean;
	noExtractEmojis?: boolean;
}

export interface NoteCreateAuthor {
	id: string;
	isSuspended: boolean;
	movedToUri: string | null;
	canPublicNote: boolean;
	rateLimitFactor: number;
	sensitiveWords: string[];
	prohibitedWords: string[];
}

export interface NewTextNote {
	id: string;
	userId: string;
	text: string;
	cw: string | null;
	visibility: TextNoteInput['visibility'];
	localOnly: boolean;
	reactionAcceptance: TextNoteInput['reactionAcceptance'];
}

export type NoteCreateErrorCode = 'CREDENTIAL_REQUIRED' | 'AUTHENTICATION_FAILED' | 'YOUR_ACCOUNT_SUSPENDED' | 'YOUR_ACCOUNT_MOVED' | 'PERMISSION_DENIED' | 'INVALID_PARAM' | 'CONTAINS_PROHIBITED_WORDS' | 'NOT_IMPLEMENTED' | 'RATE_LIMIT_EXCEEDED';

export class NoteCreateError extends Error {
	constructor(public readonly code: NoteCreateErrorCode, public readonly info?: object) {
		super(code);
	}
}
