/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { renderNote } from '../../../src/modules/note/render-note.js';
import type { NoteFacts, NoteViewMaterials } from '../../../src/modules/note/model.js';

const now = 100000;

function materials(patch: Partial<NoteFacts> = {}): NoteViewMaterials {
	const note: NoteFacts = {
		id: 'a', createdAtMs: 90000, userId: 'author', userHost: null,
		text: 'hello', name: null, cw: 'cw', visibility: 'public', localOnly: false, reactionAcceptance: null,
		visibleUserIds: [], mentions: [], tags: [], emojis: [], fileIds: [], replyId: null, replyUserId: null,
		renoteId: null, channelId: null, renoteCount: 0, repliesCount: 0, clippedCount: 0,
		reactions: {}, reactionPairs: [], hasPoll: false, uri: null, url: null, ...patch,
	};
	return { notes: new Map([['a', note]]), authors: new Map([['author', {
		id: 'author', host: null, requireSigninToViewContents: false, makeNotesFollowersOnlyBefore: null,
		makeNotesHiddenBefore: null, view: { id: 'author' },
	}]]), files: new Map(), channels: new Map(), polls: new Map(), myReactions: new Map(), buffered: new Map(),
	followedAuthorIds: new Set(), emojiUrls: new Map(), localHost: 'example.test', ugcVisibilityForVisitor: 'all' };
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

test.each([null, 'unrelated'])('specified hides only upstream content fields for %s', viewer => {
	const m = materials({ visibility: 'specified', visibleUserIds: ['viewer'], hasPoll: true });
	(m.polls as Map<string, unknown>).set('a', { multiple: false, expiresAt: null, choices: ['x'], votes: [1], myChoices: [] });
	const hidden = json(renderNote('a', m, viewer, now));
	expect(hidden).toMatchObject({ text: null, cw: null, files: [], fileIds: [], isHidden: true, hasPoll: true });
	expect(hidden).not.toHaveProperty('poll');
	expect(hidden).not.toHaveProperty('visibleUserIds');
	expect(renderNote('a', m, 'viewer', now)).not.toHaveProperty('isHidden');
	expect(renderNote('a', m, 'author', now)).not.toHaveProperty('isHidden');
});

test('followers admits follow/mention/reply author but detail:false reply lacks reply-author exception', () => {
	const m = materials({ visibility: 'followers', replyId: 'b', replyUserId: 'viewer' });
	(m.notes as Map<string, NoteFacts>).set('b', { ...m.notes.get('a')!, id: 'b', userId: 'viewer', replyId: null });
	(m.authors as Map<string, unknown>).set('viewer', { ...m.authors.get('author')!, id: 'viewer', view: { id: 'viewer' } });
	expect(renderNote('a', m, 'viewer', now)).not.toHaveProperty('isHidden');
	expect(renderNote('a', m, 'outsider', now)).toHaveProperty('isHidden', true);
	const shallow = renderNote('a', m, 'viewer', now, false);
	expect(shallow).toHaveProperty('isHidden', true);
	expect(shallow).not.toHaveProperty('reply');
	expect(shallow).not.toHaveProperty('clippedCount');
	(m.followedAuthorIds as Set<string>).add('author');
	expect(renderNote('a', m, 'follower', now)).not.toHaveProperty('isHidden');
});

test.each([0, -10, 90])('time restriction includes its exact boundary %s with author exception', threshold => {
	const m = materials();
	m.authors.get('author')!.makeNotesHiddenBefore = threshold;
	expect(renderNote('a', m, 'viewer', now)).toHaveProperty('isHidden', true);
	expect(renderNote('a', m, 'author', now)).not.toHaveProperty('isHidden');
	m.authors.get('author')!.makeNotesHiddenBefore = null;
	m.authors.get('author')!.makeNotesFollowersOnlyBefore = threshold;
	expect(renderNote('a', m, 'author', now)).toHaveProperty('visibility', 'followers');
});

test('hidden root retains independently rendered renote; missing reference is null, absent is omitted', () => {
	const m = materials({ visibility: 'specified', renoteId: 'b', replyId: 'missing' });
	(m.notes as Map<string, NoteFacts>).set('b', { ...m.notes.get('a')!, id: 'b', visibility: 'public', renoteId: null, replyId: null });
	const result = json(renderNote('a', m, null, now));
	expect(result).toMatchObject({ isHidden: true, reply: null, renote: { text: 'hello' } });
	expect(result.renote).not.toHaveProperty('reply');
});

test('attachment order/duplicates survive while missing file is omitted only from files', () => {
	const m = materials({ fileIds: ['b', 'missing', 'a', 'b'] });
	(m.files as Map<string, unknown>).set('a', { id: 'a' });
	(m.files as Map<string, unknown>).set('b', { id: 'b' });
	expect(renderNote('a', m, null, now)).toMatchObject({ fileIds: ['b', 'missing', 'a', 'b'], files: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] });
});

test('merges buffered legacy/custom reactions, drops zero, uses complete pair cache before two second gate', () => {
	const m = materials({ createdAtMs: now - 1000, reactions: { like: 1, '👍': 1, ':local:': 1, zero: 0 } });
	(m.buffered as Map<string, unknown>).set('a', { deltas: { like: 1, ':local:': -1 }, pairs: ['viewer/like', 'x/like', 'y/👍'] });
	expect(renderNote('a', m, 'viewer', now)).toMatchObject({ reactionCount: 3, reactions: { '👍': 3 }, myReaction: '👍' });
	(m.buffered as Map<string, unknown>).clear();
	(m.myReactions as Map<string, string>).set('a', 'love');
	expect(json(renderNote('a', m, 'viewer', now))).not.toHaveProperty('myReaction');
	expect(renderNote('a', m, 'viewer', now + 1000)).toHaveProperty('myReaction', '❤');
});

test('poll marks viewer choices, shallow poll omitted; missing poll fails instead of partial output', () => {
	const m = materials({ hasPoll: true });
	(m.polls as Map<string, unknown>).set('a', { multiple: true, expiresAt: null, choices: ['x', 'x', 'z'], votes: [2, 3, 4], myChoices: [1] });
	expect(renderNote('a', m, 'viewer', now)).toHaveProperty('poll', { multiple: true, expiresAt: null, choices: [
		{ text: 'x', votes: 2, isVoted: false }, { text: 'x', votes: 2, isVoted: true }, { text: 'z', votes: 4, isVoted: false },
	] });
	expect(json(renderNote('a', m, 'viewer', now, false))).not.toHaveProperty('poll');
	(m.polls as Map<string, unknown>).clear();
	expect(() => renderNote('a', m, 'viewer', now)).toThrow('NOTE_POLL_MISSING');
});

test('missing poll in a detailed nested note becomes null while root material failure remains an error', () => {
	const m = materials({ renoteId: 'b' });
	(m.notes as Map<string, NoteFacts>).set('b', { ...m.notes.get('a')!, id: 'b', renoteId: null, hasPoll: true });
	expect(renderNote('a', m, null, now)).toHaveProperty('renote', null);
	expect(() => renderNote('b', m, null, now)).toThrow('NOTE_POLL_MISSING');
});

test('missing author in a nested note becomes null without swallowing unrelated errors', () => {
	const m = materials({ replyId: 'b' });
	(m.notes as Map<string, NoteFacts>).set('b', { ...m.notes.get('a')!, id: 'b', replyId: null, userId: 'missing' });
	expect(renderNote('a', m, null, now)).toHaveProperty('reply', null);
	expect(() => renderNote('b', m, null, now)).toThrow('NOTE_AUTHOR_MISSING');
});

test('invalid saved emoji host is omitted like upstream domainToASCII instead of failing show', () => {
	const m = materials({ userHost: 'remote.test', emojis: ['blob@9999999999'] });
	expect(renderNote('a', m, null, now)).toHaveProperty('emojis', {});
});
