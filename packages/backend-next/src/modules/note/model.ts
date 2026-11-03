/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type JsonObject = { [key: string]: unknown };

export interface NoteFacts {
	id: string;
	createdAtMs: number;
	userId: string;
	userHost: string | null;
	text: string | null;
	name: string | null;
	cw: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	localOnly: boolean;
	reactionAcceptance: string | null;
	visibleUserIds: string[];
	mentions: string[];
	tags: string[];
	emojis: string[];
	fileIds: string[];
	replyId: string | null;
	replyUserId: string | null;
	renoteId: string | null;
	channelId: string | null;
	renoteCount: number;
	repliesCount: number;
	clippedCount: number;
	reactions: Record<string, number>;
	reactionPairs: string[];
	hasPoll: boolean;
	uri: string | null;
	url: string | null;
}

export interface AuthorFacts {
	id: string;
	host: string | null;
	requireSigninToViewContents: boolean;
	makeNotesFollowersOnlyBefore: number | null;
	makeNotesHiddenBefore: number | null;
	view: JsonObject;
}

export interface PollFacts {
	multiple: boolean;
	expiresAt: string | null;
	choices: string[];
	votes: number[];
	myChoices: number[];
}

export interface NoteViewMaterials {
	notes: ReadonlyMap<string, NoteFacts>;
	authors: ReadonlyMap<string, AuthorFacts>;
	files: ReadonlyMap<string, JsonObject>;
	channels: ReadonlyMap<string, JsonObject>;
	polls: ReadonlyMap<string, PollFacts>;
	myReactions: ReadonlyMap<string, string>;
	buffered: ReadonlyMap<string, { deltas: Record<string, number>; pairs: string[] }>;
	followedAuthorIds: ReadonlySet<string>;
	// Keys are name@host; local emojis are not populated by upstream.
	emojiUrls: ReadonlyMap<string, string>;
	localHost: string;
	ugcVisibilityForVisitor: 'none' | 'local' | 'all';
}

export interface NoteFactsReader {
	readGuestAccess(note: NoteFacts): Promise<{ authorRequiresSignin: boolean; ugcVisibilityForVisitor: string }>;
	readNotes(ids: readonly string[]): Promise<NoteFacts[]>;
	readMaterials(notes: ReadonlyMap<string, NoteFacts>, viewerId: string | null, now: number): Promise<NoteViewMaterials>;
}
