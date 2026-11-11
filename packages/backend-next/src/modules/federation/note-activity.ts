/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { escapeHtml, getNoteHtml } from '../mfm/public.js';
import { apContext } from './ap-context.js';
import { renderApEmoji, renderApHashtag } from './ap-tags.js';
import type { ApEmojiFacts } from './ap-tags.js';
import type { MentionedRemoteUser } from '../mfm/public.js';

const publicAddress = 'https://www.w3.org/ns/activitystreams#Public';

/** 保存済みの投稿の列のうち、AP 表現と pure Renote の判定に使うもの。 */
export interface NoteActivityNote {
	id: string;
	userId: string;
	createdAtMs: number;
	text: string | null;
	cw: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	replyId: string | null;
	renoteId: string | null;
	renoteUserHost: string | null;
	fileIds: string[];
	hasPoll: boolean;
	tags: string[];
	mentionedRemoteUsers: MentionedRemoteUser[];
}

export interface ApDocumentFacts {
	type: string;
	webpublicType: string | null;
	/** 本家 DriveFileEntityService.getPublicUrl の結果。 */
	url: string;
	comment: string | null;
	width?: number;
	height?: number;
	isSensitive: boolean;
}

/** 表現の時点で DB から読んだ材料。読み取りは呼び出し側が行い、ここでは DB に触れない。 */
export interface NoteActivityMaterials {
	note: NoteActivityNote;
	/** 返信先と、その作者の行が両方あるときだけ値を持つ。 */
	reply: { id: string; uri: string | null } | null;
	renote: { id: string; uri: string | null } | null;
	/** `mentions` のうち見つかった利用者。`mentions` の順。 */
	mentionedUsers: { id: string; username: string; host: string | null; uri: string | null }[];
	/** `fileIds` の順で、見つからないファイルを除いたもの。 */
	files: ApDocumentFacts[];
	/** `hasPoll` でも行が無ければ null。 */
	poll: { choices: string[]; multiple: boolean; votes: number[]; expiresAtMs: number | null } | null;
	/** `emojis` の順で、見つかったローカルの絵文字。 */
	emojis: ApEmojiFacts[];
}

/** 本家 NoteCreateService.isRenote && !isQuote。本家は作成時の入力で判定するが、判定に使う値はすべて同じ値のまま保存される。 */
export function isPureRenote(note: Pick<NoteActivityNote, 'renoteId' | 'text' | 'replyId' | 'cw' | 'hasPoll' | 'fileIds'>): boolean {
	return note.renoteId !== null
		&& note.text === null
		&& note.replyId === null
		&& note.cw === null
		&& !note.hasPoll
		&& note.fileIds.length === 0;
}

function localUserUri(selfUrl: string, userId: string): string {
	return `${selfUrl}/users/${userId}`;
}

function noteUri(selfUrl: string, noteId: string): string {
	return `${selfUrl}/notes/${noteId}`;
}

/** 本家 ApRendererService.renderNote（dive=false）。キーの順は本家の JSON の本文と一致させる。 */
export function renderApNote(materials: NoteActivityMaterials, options: { selfUrl: string; now: number }): Record<string, unknown> {
	const { note, reply, renote, mentionedUsers, files, poll, emojis } = materials;
	const { selfUrl } = options;

	// 本家は返信でなければ null、返信先が見つからなければキーごと省く（undefined）。
	const inReplyTo = note.replyId === null ? null : reply === null ? undefined : reply.uri ?? noteUri(selfUrl, reply.id);
	const quote = renote === null ? undefined : renote.uri ?? noteUri(selfUrl, renote.id);

	const attributedTo = localUserUri(selfUrl, note.userId);
	const mentions = note.mentionedRemoteUsers.map(user => user.uri);
	let to: string[];
	let cc: string[];
	if (note.visibility === 'public') {
		to = [publicAddress];
		cc = [`${attributedTo}/followers`, ...mentions];
	} else if (note.visibility === 'home') {
		to = [`${attributedTo}/followers`];
		cc = [publicAddress, ...mentions];
	} else if (note.visibility === 'followers') {
		to = [`${attributedTo}/followers`];
		cc = mentions;
	} else {
		to = mentions;
		cc = [];
	}

	// class 名 quote-inline は Misskey 以外のクライアントが引用の表示に使うため、この形を保つ。
	const extraHtml = quote === undefined ? null : `<br><br><span class="quote-inline">RE: <a href="${escapeHtml(quote)}">${escapeHtml(quote)}</a></span>`;
	const { content, noMisskeyContent } = getNoteHtml(note, selfUrl, extraHtml);
	const text = note.text ?? '';

	const tag = [
		...note.tags.map(name => renderApHashtag(name, selfUrl)),
		...mentionedUsers.map(user => ({
			type: 'Mention',
			href: user.host === null ? localUserUri(selfUrl, user.id) : user.uri,
			name: user.host === null ? `@${user.username}` : `@${user.username}@${user.host}`,
		})),
		...emojis.filter(emoji => !emoji.localOnly).map(emoji => renderApEmoji(emoji, selfUrl, options.now)),
	];

	// 本家は type を Question で上書きするため、type の位置は 2 番目のまま、締切と選択肢が末尾に付く。
	const asPoll = poll === null ? {} : {
		type: 'Question',
		[poll.expiresAtMs !== null && poll.expiresAtMs < options.now ? 'closed' : 'endTime']: poll.expiresAtMs === null ? null : new Date(poll.expiresAtMs).toISOString(),
		[poll.multiple ? 'anyOf' : 'oneOf']: poll.choices.map((name, i) => ({
			type: 'Note',
			name,
			replies: { type: 'Collection', totalItems: poll.votes[i] },
		})),
	};

	return {
		id: noteUri(selfUrl, note.id),
		type: 'Note',
		attributedTo,
		summary: note.cw === '' ? '\u200B' : note.cw ?? undefined,
		content,
		...(noMisskeyContent ? {} : {
			_misskey_content: text,
			source: { content: text, mediaType: 'text/x.misskeymarkdown' },
		}),
		_misskey_quote: quote,
		quoteUrl: quote,
		published: new Date(note.createdAtMs).toISOString(),
		to,
		cc,
		inReplyTo,
		attachment: files.map(file => ({
			type: 'Document',
			mediaType: file.webpublicType ?? file.type,
			url: file.url,
			name: file.comment,
			width: file.width,
			height: file.height,
			sensitive: file.isSensitive,
		})),
		sensitive: note.cw !== null || files.some(file => file.isSensitive),
		tag,
		...asPoll,
	};
}

/**
 * 本家 NoteCreateService.renderNoteOrRenoteActivity と addContext。pure Renote は Announce、それ以外は Create にする。
 * 本家が例外を投げて配送しない投稿（specified の pure Renote、MFM の ruby の一部）は、同じく例外を投げる。
 */
export function renderNoteActivity(materials: NoteActivityMaterials, options: { selfUrl: string; now: number }): Record<string, unknown> {
	const { note } = materials;
	const { selfUrl } = options;
	const actor = localUserUri(selfUrl, note.userId);
	const id = `${noteUri(selfUrl, note.id)}/activity`;
	const published = new Date(note.createdAtMs).toISOString();

	if (isPureRenote(note)) {
		return { '@context': apContext, id, actor, type: 'Announce', published, ...announceAudience(note, actor), object: announcedUri(materials, selfUrl) };
	}

	const object = renderApNote(materials, options);
	return { '@context': apContext, id, actor, type: 'Create', published, object, to: object.to, cc: object.cc };
}

function announceAudience(note: NoteActivityNote, actor: string): { to: string[]; cc: string[] } {
	if (note.visibility === 'public') {
		return { to: [publicAddress], cc: [`${actor}/followers`] };
	}
	if (note.visibility === 'home') {
		return { to: [`${actor}/followers`], cc: [publicAddress] };
	}
	if (note.visibility === 'followers') {
		return { to: [`${actor}/followers`], cc: [] };
	}
	throw new Error('renderAnnounce: cannot render non-public note');
}

function announcedUri({ note, renote }: NoteActivityMaterials, selfUrl: string): string {
	if (renote !== null) {
		return renote.uri ?? noteUri(selfUrl, renote.id);
	}

	// 本家は作成時に読んだ Renote 先から URI を作るため、表現の前に消えていても Announce を送る。
	// ローカルの投稿は uri を持たないので同じ URI を作れるが、リモートの投稿の uri は消えた行にしか無い。
	if (note.renoteUserHost === null) {
		return noteUri(selfUrl, note.renoteId!);
	}
	throw new Error('renderAnnounce: renote target is gone');
}
