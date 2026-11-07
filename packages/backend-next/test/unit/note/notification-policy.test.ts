/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { receivesPostNotification } from '../../../src/modules/notification/reception.js';
import { planNoteNotifications } from '../../../src/modules/note/notification-plan.js';

describe('current notification reception', () => {
	const facts = { recipientId: 'b', notifierId: 'a', mode: null, muted: false, followsNotifier: false, followedByNotifier: false, listContainsNotifier: false };
	test.each([
		[null, false, false, true], ['always', false, false, true], ['never', true, true, false],
		['following', false, true, false], ['following', true, false, true],
		['follower', true, false, false], ['follower', false, true, true],
		['mutualFollow', true, false, false], ['mutualFollow', true, true, true],
		['followingOrFollower', false, false, false], ['followingOrFollower', true, false, true], ['followingOrFollower', false, true, true],
	])('%s follows=%s follower=%s accepts=%s', (mode, followsNotifier, followedByNotifier, accepted) => {
		expect(receivesPostNotification({ ...facts, mode, followsNotifier, followedByNotifier })).toBe(accepted);
	});
	test('self, mute and list membership', () => {
		expect(receivesPostNotification({ ...facts, recipientId: 'a' })).toBe(false);
		expect(receivesPostNotification({ ...facts, muted: true })).toBe(false);
		expect(receivesPostNotification({ ...facts, mode: 'list' })).toBe(false);
		expect(receivesPostNotification({ ...facts, mode: 'list', listContainsNotifier: true })).toBe(true);
	});
	test('poll ended has no notifier: only never suppresses it', () => {
		expect(receivesPostNotification({ ...facts, notifierId: null, muted: true, mode: 'list' })).toBe(true);
		expect(receivesPostNotification({ ...facts, notifierId: null, mode: 'never' })).toBe(false);
	});
});

const base = {
	id: 'n', userId: 'a', visibility: 'public' as const, visibleUserIds: [], mentions: ['b'],
	reply: null, renote: null, pureRenote: false,
	localUserIds: new Set(['a', 'b', 'c']), threadMutedUserIds: new Set<string>(),
	subscribers: [{ userId: 'b', renoteMuted: false }],
};
test('subscription is independent and reply overrides mention then quote overrides reply', () => {
	expect(planNoteNotifications(base)).toEqual([{ recipientId: 'b', type: 'note', targetNoteId: null }, { recipientId: 'b', type: 'mention', targetNoteId: null }]);
	expect(planNoteNotifications({ ...base, reply: { id: 'parent', userId: 'b' } })).toEqual([{ recipientId: 'b', type: 'reply', targetNoteId: null }]);
	expect(planNoteNotifications({ ...base, reply: { id: 'parent', userId: 'b' }, renote: { id: 'original', userId: 'b' } })).toEqual([{ recipientId: 'b', type: 'quote', targetNoteId: null }]);
});
test('thread mute suppresses mention and reply, not renote; pure renote mutes only subscription', () => {
	expect(planNoteNotifications({
		...base, threadMutedUserIds: new Set(['b']), renote: { id: 'original', userId: 'b' }, pureRenote: true,
		subscribers: [{ userId: 'b', renoteMuted: true }]
	})).toEqual([{ recipientId: 'b', type: 'renote', targetNoteId: 'original' }]);
});
test('specified filters manager recipients; followers intentionally permits nonfollowers', () => {
	expect(planNoteNotifications({ ...base, visibility: 'specified', visibleUserIds: ['c'] })).toEqual([]);
	expect(planNoteNotifications({ ...base, visibility: 'followers' })).toHaveLength(2);
});
test('remote recipients and self never receive bodies', () => {
	expect(planNoteNotifications({ ...base, mentions: ['a', 'remote'], subscribers: [{ userId: 'a', renoteMuted: false }] })).toEqual([]);
});
