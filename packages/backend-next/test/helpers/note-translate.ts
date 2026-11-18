/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createTranslateNote } from '../../src/modules/note-translate/public.js';
import { createAccessRequest } from '../../src/modules/access/public.js';
import type { NoteFacts, NoteViewMaterials } from '../../src/modules/note/public.js';

export const note: NoteFacts = {
	id: '0000000001', createdAtMs: 1, userId: 'author', userHost: null, text: 'Hello & goodbye', cw: 'CW', name: null,
	visibility: 'public', visibleUserIds: [], mentions: [], tags: [], emojis: [], fileIds: [], replyId: null, replyUserId: null,
	renoteId: null, channelId: null, renoteCount: 0, repliesCount: 0, clippedCount: 0, reactions: {}, reactionPairs: [], hasPoll: false,
	uri: null, url: null, localOnly: false, reactionAcceptance: null,
};
export function setup(options: { note?: Partial<NoteFacts> | null; key?: string | null; pro?: boolean; allowed?: boolean; hidden?: boolean; fail?: boolean; response?: unknown; followingUnavailable?: boolean } = {}) {
	const root = options.note === null ? null : { ...note, ...options.note };
	const calls: unknown[] = [];
	const materials: NoteViewMaterials = {
		notes: new Map(root ? [[root.id, root]] : []),
		authors: new Map([['author', { id: 'author', host: null, requireSigninToViewContents: false, makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: options.hidden ? 100 : null, view: {} }]]),
		files: new Map(), channels: new Map(), polls: new Map(), myReactions: new Map(), buffered: new Map(), followedAuthorIds: new Set(), emojiUrls: new Map(), localHost: 'example.test', ugcVisibilityForVisitor: 'all',
	};
	const application = createTranslateNote({
		readActor: async () => ({ id: 'viewer', host: null, isSuspended: false, isModerator: false, isAdministrator: false }),
		canUseTranslator: async () => options.allowed ?? true,
		isFollowing: async () => {
			if (options.followingUnavailable) {
				throw Error('following store unavailable');
			}
			return false;
		},
		notes: { readNotes: async () => root ? [root] : [], readMaterials: async () => materials },
		readSettings: async () => ({ deeplAuthKey: options.key === undefined ? 'test-key' : options.key, deeplIsPro: options.pro ?? false }),
		send: async (url, request) => {
			calls.push({ url, ...request });
			if (options.fail) {
				throw Error('test-key in unsafe transport failure');
			}
			return { status: 200, statusText: 'OK', finalUrl: url, header: () => null, text: async () => '', json: async () => options.response ?? { translations: [{ detected_source_language: 'EN', text: 'こんにちは' }] } };
		},
	});
	const run = (targetLang = 'JA-JP') => application.translateNote(createAccessRequest({ requireCredential: true, kind: 'read:account' }, { userId: 'viewer', native: true }), { noteId: note.id, targetLang }, 1000);
	return { run, calls, application };
}
