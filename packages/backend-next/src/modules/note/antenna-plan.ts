/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteVisibility } from './create-contract.js';
export interface AntennaDefinition {
	id: string;
	userId: string;
	src: 'home' | 'all' | 'users' | 'list' | 'users_blacklist';
	userListId: string | null;
	users: string[];
	keywords: string[][];
	excludeKeywords: string[][];
	caseSensitive: boolean;
	excludeBots: boolean;
	withReplies: boolean;
	withFile: boolean;
	isActive: boolean;
	localOnly: boolean;
	excludeNotesInSensitiveChannel: boolean;
}
export interface AntennaNote {
	id: string;
	userId: string;
	visibility: NoteVisibility;
	visibleUserIds?: readonly string[];
	text: string | null;
	cw: string | null;
	replyId: string | null;
	fileIds?: readonly string[];
	channel?: {
		isSensitive: boolean;
	} | null;
}
export interface AntennaAuthor {
	id: string;
	username: string;
	host: string | null;
	isBot: boolean;
}
export interface AntennaMatchPorts {
	followingIds(ownerId: string): Promise<ReadonlySet<string>>;
	listContains(listId: string, authorId: string): Promise<boolean>;
	fullApAccount(username: string, host: string | null): string;
}
export async function checkHitAntenna(antenna: AntennaDefinition, note: AntennaNote, author: AntennaAuthor, ports: AntennaMatchPorts): Promise<boolean> {
	if (antenna.excludeNotesInSensitiveChannel && note.channel?.isSensitive) {
		return false;
	}
	if (antenna.excludeBots && author.isBot) {
		return false;
	}
	if (antenna.localOnly && author.host != null) {
		return false;
	}
	if (!antenna.withReplies && note.replyId != null) {
		return false;
	}
	if (note.visibility === 'specified' && note.userId !== antenna.userId && !note.visibleUserIds?.includes(antenna.userId)) {
		return false;
	}
	if (note.visibility === 'followers') {
		const following = await ports.followingIds(antenna.userId);
		if (note.userId !== antenna.userId && !following.has(note.userId)) {
			return false;
		}
	}
	if (antenna.src === 'list') {
		if (antenna.userListId == null || !await ports.listContains(antenna.userListId, author.id)) {
			return false;
		}
	} else if (antenna.src === 'users' || antenna.src === 'users_blacklist') {
		const account = ports.fullApAccount(author.username, author.host).toLowerCase();
		const listed = antenna.users.some(value => {
			// 本家 Acct.parse は先頭の @ を一つだけ除き、split の最初の二要素を使う。
			const [username, host] = (value.startsWith('@') ? value.slice(1) : value).split('@', 2);
			return ports.fullApAccount(username, host ?? null).toLowerCase() === account;
		});
		if (antenna.src === 'users' ? !listed : listed) {
			return false;
		}
	}
	const include = antenna.keywords.map(group => group.filter(word => word !== '')).filter(group => group.length > 0);
	const exclude = antenna.excludeKeywords.map(group => group.filter(word => word !== '')).filter(group => group.length > 0);
	const matches = (groups: string[][]) => {
		const text = `${note.text ?? ''}\n${note.cw ?? ''}`;
		const target = antenna.caseSensitive ? text : text.toLowerCase();
		return groups.some(group => group.every(word => target.includes(antenna.caseSensitive ? word : word.toLowerCase())));
	};
	if (include.length > 0 && ((note.text == null && note.cw == null) || !matches(include))) {
		return false;
	}
	if (exclude.length > 0 && ((note.text == null && note.cw == null) || matches(exclude))) {
		return false;
	}
	if (antenna.withFile && note.fileIds && note.fileIds.length === 0) {
		return false;
	}
	return true;
}
