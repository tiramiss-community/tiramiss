/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import { createRecommendPolls } from '../../../src/modules/poll-recommendation/public.js';
import type { NoteFacts, NoteFactsReader } from '../../../src/modules/note/model.js';

const access = () => createAccessRequest({ requireCredential: true, kind: 'read:account' }, { userId: 'viewer', native: true });
const root: NoteFacts = {
	id: 'b', createdAtMs: -10000, userId: 'author', userHost: null, text: 'snapshot', name: null, cw: null,
	visibility: 'public', localOnly: true, reactionAcceptance: null, visibleUserIds: [], mentions: [], tags: [], emojis: [],
	fileIds: [], replyId: null, replyUserId: null, renoteId: null, channelId: null, renoteCount: 0, repliesCount: 0,
	clippedCount: 0, reactions: { like: 1 }, reactionPairs: [], hasPoll: false, uri: null, url: null,
};
const facts = { isSuspended: false, isModerator: false, isAdministrator: false };
const unused = async (): Promise<never> => {
	throw new Error('unexpected read'); 
};

test('authorization precedes parameter validation and candidate selection', async () => {
	const usecase = createRecommendPolls({ readAccessFacts: async () => ({ ...facts, isSuspended: true }), readPage: unused });
	await expect(usecase.recommendPolls(access(), { limit: 0 }, 1000)).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	await expect(usecase.recommendPolls(createAccessRequest({ requireCredential: true }, null), {}, 1000)).rejects.toMatchObject({ reason: 'CREDENTIAL_REQUIRED' });
	const denied = createAccessRequest({ requireCredential: true, kind: 'read:account' }, { userId: 'viewer', native: false, permissions: new Set() });
	await expect(createRecommendPolls({ readAccessFacts: async () => facts, readPage: unused }).recommendPolls(denied, { limit: 0 }, 1000)).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' });
});

test('empty refetched notes avoid graph and material reads', async () => {
	const usecase = createRecommendPolls({ readAccessFacts: async () => facts, readPage: async () => ({ roots: [], reader: { readNotes: unused, readMaterials: unused } }) });
	expect(await usecase.recommendPolls(access(), {}, 1000)).toEqual([]);
});

test('refetched snapshots preserve descending order and render for the authenticated viewer', async () => {
	const reader: Pick<NoteFactsReader, 'readNotes' | 'readMaterials'> = {
		readNotes: unused,
		async readMaterials(notes, viewerId, now) {
			expect(viewerId).toBe('viewer');
			expect(now).toBe(1000);
			return { notes, authors: new Map([['author', { id: 'author', host: null, requireSigninToViewContents: true,
																																																		makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: null, view: { id: 'author' } }]]),
												files: new Map(), channels: new Map(), polls: new Map(), myReactions: new Map([['b', 'like']]), buffered: new Map(),
												followedAuthorIds: new Set(), emojiUrls: new Map(), localHost: 'example.test', ugcVisibilityForVisitor: 'none' };
		},
	};
	const usecase = createRecommendPolls({ readAccessFacts: async () => facts, async readPage(input, viewerId, now) {
		expect(input).toEqual({ limit: 10, offset: 0, excludeChannels: false });
		expect(viewerId).toBe('viewer');
		expect(now).toBe(1000);
		return { roots: [root, { ...root, id: 'a' }], reader };
	} });
	expect(await usecase.recommendPolls(access(), {}, 1000)).toMatchObject([{ id: 'b', text: 'snapshot', myReaction: '👍' }, { id: 'a', text: 'snapshot' }]);
});
