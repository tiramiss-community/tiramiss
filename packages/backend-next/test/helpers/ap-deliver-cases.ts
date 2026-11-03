/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { publicFileUrl } from '../../src/platform/database/note-files.js';
import { createIdCodec } from '../../src/platform/id-codec.js';
import type { MiDriveFile } from 'backend-upstream/entities';
import type { NoteActivityMaterials, NoteDeliveryFacts } from '../../src/modules/federation/public.js';

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

type RenderCaseInput = RenderCases['inputs']['cases'][number];

const codec = createIdCodec('aidx');

/** 本家の probe と同じ行を、表現の時点で読めた材料に直す。消えた行と作者のいない返信先は読めなかったものとして扱う。 */
export function renderMaterialsFor(inputs: RenderCases['inputs'], c: RenderCaseInput): NoteActivityMaterials {
	const { note } = c;
	const users = new Map(inputs.users.map(u => [u.id, u]));
	const notes = new Map(inputs.notes.map(n => [n.id, n]));
	const deleted = new Set(c.deletedBeforeRender);
	const row = (id: string | null) => (id === null || deleted.has(id) ? undefined : notes.get(id));
	const reply = row(note.replyId);
	const renote = row(note.renoteId);
	const poll = inputs.polls[note.id];

	return {
		note: {
			id: note.id, userId: note.userId, createdAtMs: codec.createdAtFromId(note.id), text: note.text, cw: note.cw, visibility: note.visibility,
			replyId: note.replyId, renoteId: note.renoteId, renoteUserHost: note.renoteId === null ? null : notes.get(note.renoteId)!.userHost,
			fileIds: note.fileIds, hasPoll: note.hasPoll, tags: note.tags, mentionedRemoteUsers: JSON.parse(note.mentionedRemoteUsers),
		},
		reply: reply && users.has(reply.userId) ? { id: reply.id, uri: reply.uri } : null,
		renote: renote ? { id: renote.id, uri: renote.uri } : null,
		mentionedUsers: note.mentions.flatMap(id => inputs.users.filter(u => u.id === id)),
		files: note.fileIds.flatMap(id => inputs.files.filter(f => f.id === id)).map(file => ({
			type: file.type, webpublicType: file.webpublicType, url: publicFileUrl(file as unknown as MiDriveFile, true, { url: inputs.selfUrl }),
			comment: file.comment, width: file.properties.width, height: file.properties.height, isSensitive: file.isSensitive,
		})),
		poll: note.hasPoll && poll ? { choices: poll.choices, multiple: poll.multiple, votes: poll.votes, expiresAtMs: poll.expiresAt === null ? null : Date.parse(poll.expiresAt) } : null,
		emojis: note.emojis.flatMap(name => inputs.emojis.filter(e => e.name === name)).map(emoji => ({
			name: emoji.name, type: emoji.type, publicUrl: emoji.publicUrl, originalUrl: emoji.originalUrl, license: emoji.license,
			localOnly: emoji.localOnly, updatedAtMs: emoji.updatedAt === null ? null : Date.parse(emoji.updatedAt),
		})),
	};
}

/** 保存時に返信先・Renote 先から写した列。本家の入力 data と同じく、表現の前に消えた投稿の値も残る。 */
export function deliveryFactsFor(inputs: RenderCases['inputs'], c: RenderCaseInput): NoteDeliveryFacts {
	const { note } = c;
	const target = (id: string | null) => (id === null ? undefined : inputs.notes.find(n => n.id === id));
	const reply = target(note.replyId);
	const renote = target(note.renoteId);
	return {
		userHost: note.userHost,
		localOnly: note.localOnly,
		mentions: note.mentions,
		replyUserId: reply?.userId ?? null,
		replyUserHost: reply?.userHost ?? null,
		renoteUserId: renote?.userId ?? null,
		renoteUserHost: renote?.userHost ?? null,
	};
}
