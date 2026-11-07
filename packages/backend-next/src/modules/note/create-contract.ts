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
	isBot: boolean;
	canPublicNote: boolean;
	mentionLimit: number;
	rateLimitFactor: number;
	sensitiveWords: string[];
	prohibitedWords: string[];
}

export interface NoteAttachableFile {
	id: string;
	type: string;
}

// 返信先・Renote 対象の判定と非正規化列に使う値。保存済みの pure Renote 判定のため本文の有無も持つ。
export interface RelatedNote {
	eventFacts?: import('./model.js').NoteFacts;
	id: string;
	userId: string;
	userHost: string | null;
	text: string | null;
	cw: string | null;
	fileIds: string[];
	hasPoll: boolean;
	replyId: string | null;
	renoteId: string | null;
	threadId: string | null;
	channelId: string | null;
	visibility: NoteVisibility;
	visibleUserIds: string[];
	mentions: string[];
	replyUserId: string | null;
	localOnly: boolean;
}

export interface RelatedChannel {
	id: string;
	allowRenoteToExternal: boolean;
}

// 本家 Note.mentionedRemoteUsers の要素。url は profile に無ければキーごと省く。
export interface MentionedRemoteUser {
	uri: string;
	url?: string;
	username: string;
	host: string;
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
	replyId: string | null;
	renoteId: string | null;
	threadId: string | null;
	replyUserId: string | null;
	replyUserHost: string | null;
	renoteUserId: string | null;
	renoteUserHost: string | null;
	renoteChannelId: string | null;
	visibleUserIds: string[];
	mentions: string[];
	mentionedRemoteUsers: MentionedRemoteUser[];
	tags: string[];
	emojis: string[];
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

export interface NoteCreatedSnapshot {
	note: NewNote;
	reply: RelatedNote | null;
	renote: RelatedNote | null;
}

// 加算・ジョブは ID と期限だけを使い、通知と stream は保存時の投稿を使う。
export interface NotePostSaveInput {
	// 投票終了ジョブの名前と内容。失敗時にどの投稿の後続処理が欠けたかの記録にも使う。
	noteId: string;
	userId: string;
	// 加算の要否は作成時の事実で決まるため、後続処理では判断し直さず ID の有無だけを見る。
	repliedNoteId: string | null;
	renotedNoteId: string | null;
	channelId: string | null;
	// 期限のある投票を持つときだけ値を持ち、投票終了ジョブを投入する。
	pollExpiresAtMs: number | null;
	createdSnapshot?: NoteCreatedSnapshot;
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
