/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { renderApNote, noteAudience, renderApHashtag, renderApEmoji } from '../modules/federation/public.js';
import { escapeHtml, getNoteHtml } from '../modules/mfm/public.js';
import type { NotePublicationReader, NotePublicationRow, PreparedApNoteMaterials } from '../modules/federation/public.js';
import type { MentionedRemoteUser } from '../modules/mfm/public.js';
/** Acquire facts between pure preparation steps: an inner failure must precede any outer quote/media read. */
export async function preparePublishedNote(row: NotePublicationRow, reader: NotePublicationReader, options: {
	selfUrl: string;
	now: number;
	createdAtFromId(id: string): number;
}, dive = true): Promise<PreparedApNoteMaterials> {
	let reply: PreparedApNoteMaterials['reply'] = null;
	let embeddedReply: Record<string, unknown> | null = null;
	if (row.replyId) {
		const target = await reader.readNote(row.replyId);
		if (target !== null && await reader.authorExists(target.userId)) {
			reply = { id: target.id, uri: target.uri };
			if (!target.uri && dive) {
				embeddedReply = renderApNote(await preparePublishedNote(target, reader, options, false), options, false);
			}
		}
	}
	const renote = row.renoteId ? await reader.readNote(row.renoteId) : null;
	const audience = noteAudience(row.visibility, `${options.selfUrl}/users/${row.userId}`, (JSON.parse(row.mentionedRemoteUsers) as MentionedRemoteUser[]).map(user => user.uri));
	const mentionedRemoteUsers = JSON.parse(row.mentionedRemoteUsers) as MentionedRemoteUser[];
	const mentionedUsers = row.mentions.length > 0 ? await reader.readMentionedUsers(row.mentions) : [];
	const baseTags: Record<string, unknown>[] = [...row.tags.map(name => renderApHashtag(name, options.selfUrl)), ...mentionedUsers.map(user => ({ type: 'Mention', href: user.host === null ? `${options.selfUrl}/users/${user.id}` : user.uri, name: user.host === null ? `@${user.username}` : `@${user.username}@${user.host}` }))];
	const files = row.fileIds.length > 0 ? await reader.readFiles(row.fileIds) : [];
	const poll = row.hasPoll ? await reader.readPoll(row.id) : null;
	const quote = renote === null ? undefined : renote.uri || `${options.selfUrl}/notes/${renote.id}`;
	const extraHtml = quote === undefined ? null : `<br><br><span class="quote-inline">RE: <a href="${escapeHtml(quote)}">${escapeHtml(quote)}</a></span>`;
	const html = getNoteHtml({ text: row.text, mentionedRemoteUsers }, options.selfUrl, extraHtml);
	const emojis = row.emojis.length > 0 ? await reader.readEmojis(row.emojis) : [];
	const tag = [...baseTags, ...emojis.filter(emoji => !emoji.localOnly).map(emoji => renderApEmoji(emoji, options.selfUrl, options.now))];
	return {
		note: { ...row, mentionedRemoteUsers, createdAtMs: options.createdAtFromId(row.id) },
		reply, embeddedReply, renote, mentionedUsers, files, poll, emojis, html, audience, tag,
	};
}
