/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createListNotes } from '../../../src/modules/note/list-notes.js';
import type { NoteFacts, NoteFactsReader } from '../../../src/modules/note/model.js';

const root: NoteFacts = {
	id: 'a', createdAtMs: 1000, userId: 'author', userHost: null, text: 'selected snapshot', name: null, cw: null,
	visibility: 'public', localOnly: false, reactionAcceptance: null, visibleUserIds: [], mentions: [], tags: [], emojis: [],
	fileIds: [], replyId: null, replyUserId: null, renoteId: null, channelId: null, renoteCount: 0, repliesCount: 0,
	clippedCount: 0, reactions: {}, reactionPairs: [], hasPoll: false, uri: null, url: null,
};

test('selection snapshots survive root deletion before materials and authenticated selection still packs as guest', async () => {
	const reader: NoteFactsReader = {
		async readNotes() {
			throw new Error('root was deleted after selection');
		},
		async readGuestAccess() {
			throw new Error('list must not apply show restrictions');
		},
		async readMaterials(notes, viewerId) {
			expect(viewerId).toBeNull();
			return { notes, authors: new Map([['author', { id: 'author', host: null, requireSigninToViewContents: false,
				makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: null, view: { id: 'author' } }]]),
			files: new Map(), channels: new Map(), polls: new Map(), myReactions: new Map(), buffered: new Map(),
			followedAuthorIds: new Set(), emojiUrls: new Map(), localHost: 'example.test', ugcVisibilityForVisitor: 'all' };
		},
	};
	const list = createListNotes({ async readPage() {
		return { roots: [root], reader };
	} }, date => String(date));
	expect(await list.listNotes({ local: false, limit: 10 }, 'viewer', 1000)).toMatchObject([{ id: 'a', text: 'selected snapshot' }]);
});

test('an empty page avoids note graph and materials reads', async () => {
	const reader = new Proxy({} as NoteFactsReader, { get() {
		throw new Error('unnecessary note read');
	} });
	const list = createListNotes({ async readPage() {
		return { roots: [], reader };
	} }, date => String(date));
	expect(await list.listNotes({ local: false, limit: 10 }, null, 1000)).toEqual([]);
});
