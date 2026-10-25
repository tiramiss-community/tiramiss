/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { domainToASCII } from 'node:url';
import { noteVisibility, shouldHideNote } from './visibility.js';
import { mergeReactions, normalizeReaction } from './reactions.js';
import type { JsonObject, NoteViewMaterials } from './model.js';

class NoteMaterialMissing extends Error {}

export function populateEmojis(names: readonly string[], host: string | null, materials: Pick<NoteViewMaterials, 'emojiUrls' | 'localHost'>): Record<string, string> {
	return Object.fromEntries(names.flatMap(value => {
		const match = value.match(/^([-\w]+)(?:@([\w.-]+))?$/);
		if (!match) {
			return [];
		}
		const target = match[2] ?? host;
		if (!target || target === '.' || domainToASCII(target.toLowerCase()) === domainToASCII(materials.localHost.toLowerCase())) {
			return [];
		}
		const url = materials.emojiUrls.get(`${match[1]}@${domainToASCII(target.toLowerCase())}`);
		return url ? [[value, url]] : [];
	}));
}

export function renderNote(id: string, materials: NoteViewMaterials, viewerId: string | null, now: number, detail = true): JsonObject {
	const note = materials.notes.get(id);
	if (!note) {
		throw new NoteMaterialMissing('NOTE_MISSING');
	}
	const author = materials.authors.get(note.userId);
	if (!author) {
		throw new NoteMaterialMissing('NOTE_AUTHOR_MISSING');
	}
	const buffered = materials.buffered.get(id);
	const reactions = mergeReactions(note.reactions, buffered?.deltas ?? {});
	const reactionCount = Object.values(reactions).reduce((a, b) => a + b, 0);
	const pairs = [...note.reactionPairs, ...(buffered?.pairs ?? [])];
	const reaction = viewerId && reactionCount > 0
		? reactionCount <= pairs.length
			? pairs.find(pair => pair.startsWith(viewerId))?.split('/')[1]
			: note.createdAtMs + 2000 > now ? undefined : materials.myReactions.get(id)
		: undefined;
	const nested = (target: string, targetDetail: boolean) => {
		try {
			return renderNote(target, materials, viewerId, now, targetDetail);
		} catch (error) {
			// 本家のnullIfEntityNotFoundは、参照先自身だけでなくPoll/作者の欠落もnullにする。
			if (error instanceof NoteMaterialMissing) {
				return null;
			}
			throw error;
		}
	};
	const reply = detail && note.replyId ? nested(note.replyId, false) : undefined;
	const renote = detail && note.renoteId ? nested(note.renoteId, true) : undefined;
	const channel = note.channelId ? materials.channels.get(note.channelId) : undefined;
	const visibility = noteVisibility(note, author, now);
	const result: JsonObject = {
		id, createdAt: new Date(note.createdAtMs).toISOString(), userId: note.userId, user: author.view,
		text: note.name && (note.url ?? note.uri) ? `【${note.name}】\n${(note.text ?? '').trim()}\n\n${note.url ?? note.uri}` : note.text,
		cw: note.cw, visibility, localOnly: note.localOnly, reactionAcceptance: note.reactionAcceptance,
		...(note.visibility === 'specified' ? { visibleUserIds: [...note.visibleUserIds] } : {}),
		renoteCount: note.renoteCount, repliesCount: note.repliesCount, reactionCount, reactions,
		reactionEmojis: populateEmojis(Object.keys(reactions).filter(x => x.startsWith(':') && x.includes('@') && !x.includes('@.')).map(x => x.replaceAll(':', '')), note.userHost, materials),
		...(note.userHost !== null ? { emojis: populateEmojis(note.emojis, note.userHost, materials) } : {}),
		...(note.tags.length > 0 ? { tags: [...note.tags] } : {}),
		fileIds: [...note.fileIds], files: note.fileIds.flatMap(fileId => materials.files.has(fileId) ? [materials.files.get(fileId)!] : []),
		replyId: note.replyId, renoteId: note.renoteId,
		...(note.channelId ? { channelId: note.channelId } : {}), ...(channel ? { channel } : {}),
		...(note.mentions.length > 0 ? { mentions: [...note.mentions] } : {}),
		...(note.hasPoll ? { hasPoll: true } : {}), ...(note.uri !== null ? { uri: note.uri } : {}), ...(note.url !== null ? { url: note.url } : {}),
		...(detail ? { clippedCount: note.clippedCount, ...(reply !== undefined ? { reply } : {}), ...(renote !== undefined ? { renote } : {}),
			...(reaction ? { myReaction: normalizeReaction(reaction) } : {}) } : {}),
	};
	if (detail && note.hasPoll) {
		const poll = materials.polls.get(id);
		if (!poll) {
			throw new NoteMaterialMissing('NOTE_POLL_MISSING');
		}
		const myChoices = new Set(viewerId ? poll.multiple ? poll.myChoices : poll.myChoices.slice(0, 1) : []);
		result.poll = { multiple: poll.multiple, expiresAt: poll.expiresAt,
			choices: poll.choices.map((text, index) => ({ text, votes: poll.votes[poll.choices.indexOf(text)], isVoted: myChoices.has(index) })) };
	}
	if (shouldHideNote(note, author, viewerId, { visibility, replyAuthorId: reply?.userId as string | undefined,
		isFollowing: materials.followedAuthorIds.has(note.userId), visitorsAllowed: materials.ugcVisibilityForVisitor !== 'none', now })) {
		delete result.visibleUserIds;
		delete result.poll;
		Object.assign(result, { fileIds: [], files: [], text: null, cw: null, isHidden: true });
	}
	return result;
}
