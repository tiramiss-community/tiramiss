/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';

const compatibility = new URL('../../../../docs/superpowers/compatibility/ap-deliver/', import.meta.url);

export function loadApDeliverCases<T>(name: string): T {
	return JSON.parse(readFileSync(new URL(name, compatibility), 'utf8')) as T;
}

export interface RenderUser { id: string; username: string; host: string | null; uri: string | null; inbox: string | null; sharedInbox: string | null; profileUrl: string | null }

export interface RenderNoteRow {
	id: string;
	userId: string;
	userHost: string | null;
	uri: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	localOnly: boolean;
	channelId: string | null;
	threadId: string | null;
}

export interface RenderCaseNote extends RenderNoteRow {
	text: string | null;
	cw: string | null;
	replyId: string | null;
	renoteId: string | null;
	fileIds: string[];
	hasPoll: boolean;
	tags: string[];
	emojis: string[];
	mentions: string[];
	visibleUserIds: string[];
	mentionedRemoteUsers: string;
}

export interface RenderFile {
	id: string;
	type: string;
	webpublicType: string | null;
	url: string;
	webpublicUrl: string | null;
	comment: string | null;
	properties: { width?: number; height?: number };
	isSensitive: boolean;
	uri: string | null;
	userHost: string | null;
	isLink: boolean;
	webpublicAccessKey: string | null;
}

export interface RenderEmoji { name: string; host: null; type: string | null; publicUrl: string; originalUrl: string; license: string | null; localOnly: boolean; updatedAt: string | null }

export interface RenderCases {
	inputs: {
		selfUrl: string;
		now: string;
		users: RenderUser[];
		notes: RenderNoteRow[];
		files: RenderFile[];
		polls: Record<string, { noteId: string; choices: string[]; multiple: boolean; votes: number[]; expiresAt: string | null }>;
		emojis: RenderEmoji[];
		cases: { id: string; note: RenderCaseNote; followers: string[]; deletedBeforeRender: string[]; author: string }[];
	};
	cases: {
		id: string;
		reachedDeliver: boolean;
		activity: string | null;
		relay: boolean;
		directUserLookups: string[];
		followingsQueries: unknown[];
		addBulk: { digest: string | null; jobs: { name: string; to: string; isSharedInbox: boolean }[] } | null;
		unhandledRejections: string[];
	}[];
}

/**
 * 本家はメンションの tag を順序の決まらない問い合わせの返却順で並べる（設計判断 6）。
 * tag の中のメンションだけを href の順に並べ替え、他のキーの順と値はそのまま比べられる文字列にする。
 */
export function withMentionTagsAsSet(activity: string): string {
	const parsed = JSON.parse(activity) as { object?: unknown };
	const object = parsed.object as { tag?: { type: string; href?: string }[] } | string | undefined;
	if (typeof object === 'object' && Array.isArray(object.tag)) {
		const mentions = object.tag.filter(tag => tag.type === 'Mention').sort((a, b) => (a.href ?? '').localeCompare(b.href ?? ''));
		object.tag = object.tag.map(tag => tag.type === 'Mention' ? mentions.shift()! : tag);
	}
	return JSON.stringify(parsed);
}
