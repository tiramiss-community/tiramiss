/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface NoteCreateActor {
	userId: string;
	canWriteNote: boolean;
}

export type NoteVisibility = 'public' | 'home' | 'followers' | 'specified';

export type NoteReactionAcceptance = null | 'likeOnly' | 'likeOnlyForRemote' | 'nonSensitiveOnly' | 'nonSensitiveOnlyForLocalLikeOnlyForRemote';

export interface NotePollInput {
	choices: string[];
	multiple: boolean;
	expiresAtMs: number | null;
}

export interface NoteInput {
	text: string | null;
	cw: string | null;
	visibility: NoteVisibility;
	localOnly: boolean;
	reactionAcceptance: NoteReactionAcceptance;
	fileIds: string[];
	poll: NotePollInput | null;
	replyId: string | null;
	renoteId: string | null;
	channelId: string | null;
	visibleUserIds: string[];
	noExtractMentions: boolean;
	noExtractHashtags: boolean;
	noExtractEmojis: boolean;
}

export interface NoteCreateAuthor {
	id: string;
	host: string | null;
	isSuspended: boolean;
	movedToUri: string | null;
	canPublicNote: boolean;
	rateLimitFactor: number;
	sensitiveWords: string[];
	prohibitedWords: string[];
}

export interface NoteAttachableFile {
	id: string;
	type: string;
}

export interface NewNote {
	id: string;
	userId: string;
	userHost: string | null;
	text: string | null;
	cw: string | null;
	visibility: NoteVisibility;
	localOnly: boolean;
	reactionAcceptance: NoteReactionAcceptance;
	channelId: string | null;
	fileIds: string[];
	attachedFileTypes: string[];
	hasPoll: boolean;
}

export interface NewPoll {
	noteId: string;
	choices: string[];
	multiple: boolean;
	expiresAtMs: number | null;
	votes: number[];
	noteVisibility: NoteVisibility;
	userId: string;
	userHost: string | null;
	channelId: string | null;
}

export interface NoteWrites {
	insertNote(note: NewNote): Promise<void>;
	insertPoll(poll: NewPoll): Promise<void>;
}

// Note 全体を渡すと後続処理が DB の読み直しや描画用の値に依存するため、加算の判断に使う値だけを渡す。
export interface NotePostSaveInput {
	userId: string;
}

export type NoteCreateErrorCode =
	| 'CREDENTIAL_REQUIRED' | 'AUTHENTICATION_FAILED' | 'YOUR_ACCOUNT_SUSPENDED' | 'YOUR_ACCOUNT_MOVED' | 'PERMISSION_DENIED'
	| 'INVALID_PARAM' | 'RATE_LIMIT_EXCEEDED' | 'NOT_IMPLEMENTED'
	| 'NO_SUCH_FILE' | 'NO_SUCH_RENOTE_TARGET' | 'CANNOT_RENOTE_TO_A_PURE_RENOTE' | 'YOU_HAVE_BEEN_BLOCKED' | 'CANNOT_RENOTE_DUE_TO_VISIBILITY'
	| 'NO_SUCH_CHANNEL' | 'CANNOT_RENOTE_OUTSIDE_OF_CHANNEL' | 'NO_SUCH_REPLY_TARGET' | 'CANNOT_REPLY_TO_A_PURE_RENOTE'
	| 'CANNOT_REPLY_TO_AN_INVISIBLE_NOTE' | 'CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY'
	| 'CANNOT_CREATE_ALREADY_EXPIRED_POLL' | 'CONTAINS_PROHIBITED_WORDS' | 'CONTAINS_TOO_MANY_MENTIONS';

export class NoteCreateError extends Error {
	constructor(public readonly code: NoteCreateErrorCode, public readonly info?: object) {
		super(code);
	}
}
