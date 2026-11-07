/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { planNoteTimelines, sampleTimelineFollowers } from '../../../src/modules/note/timeline-plan.js';
import type { TimelineNote, TimelineMaterials } from '../../../src/modules/note/timeline-plan.js';

const note: TimelineNote = { id: 'note', userId: 'author', userHost: null, visibility: 'public', visibleUserIds: [], replyId: null, replyUserId: null, replyUserHost: null, channelId: null, fileIds: [] };
const materials: TimelineMaterials = {
	limits: { localUser: 300, remoteUser: 100, home: 301, list: 303, channel: 1000 },
	followers: [{ followerId: 'follower', withReplies: false }, { followerId: 'reply-lover', withReplies: true }],
	lists: [{ userListId: 'list', userListUserId: 'owner', withReplies: false }], channelFollowers: [],
};
const names = (value: TimelineNote, facts = materials) => planNoteTimelines(value, facts).map(x => x.name);

test('public note routes to home/list/own/user/local lists with upstream lengths', () => {
	expect(planNoteTimelines(note, materials)).toEqual([
		{ name: 'homeTimeline:follower', maxlen: 301 }, { name: 'homeTimeline:reply-lover', maxlen: 301 },
		{ name: 'userListTimeline:list', maxlen: 303 }, { name: 'homeTimeline:author', maxlen: 301 },
		{ name: 'userTimeline:author', maxlen: 300 }, { name: 'localTimeline', maxlen: 1000 },
	]);
});
test('files preserve fractional half lengths and local file cache uses 500', () => {
	const planned = planNoteTimelines({ ...note, fileIds: ['file'] }, materials);
	expect(planned.filter(x => x.name.includes('WithFiles'))).toEqual([
		{ name: 'homeTimelineWithFiles:follower', maxlen: 150.5 }, { name: 'homeTimelineWithFiles:reply-lover', maxlen: 150.5 },
		{ name: 'userListTimelineWithFiles:list', maxlen: 151.5 }, { name: 'homeTimelineWithFiles:author', maxlen: 150.5 },
		{ name: 'userTimelineWithFiles:author', maxlen: 150 }, { name: 'localTimelineWithFiles', maxlen: 500 },
	]);
});
test('reply routing uses recipient identity and withReplies without losing self replies', () => {
	const reply = { ...note, replyId: 'parent', replyUserId: 'follower' };
	expect(names(reply)).toEqual(['homeTimeline:follower', 'homeTimeline:reply-lover', 'homeTimeline:author', 'userTimelineWithReplies:author', 'localTimelineWithReplies', 'localTimelineWithReplyTo:follower']);
	expect(names({ ...reply, replyUserHost: 'remote.test' })).not.toContain('localTimelineWithReplyTo:follower');
	expect(names({ ...reply, replyUserId: 'elsewhere' })).not.toContain('homeTimeline:follower');
	expect(names({ ...reply, replyUserId: 'author' })).toEqual(names(note));
});
test('followers-only lists require author ownership or an active local following', () => {
	const facts = { ...materials, lists: [...materials.lists, { userListId: 'own', userListUserId: 'author', withReplies: false }, { userListId: 'following', userListUserId: 'follower', withReplies: false }] };
	expect(names({ ...note, visibility: 'followers' }, facts)).toEqual(['homeTimeline:follower', 'homeTimeline:reply-lover', 'userListTimeline:own', 'userListTimeline:following', 'homeTimeline:author', 'userTimeline:author']);
});
test('specified filters recipients but preserves the unusual own-home exclusion', () => {
	const facts = { ...materials, lists: [{ userListId: 'own', userListUserId: 'author', withReplies: false }, { userListId: 'allowed', userListUserId: 'follower', withReplies: false }] };
	expect(names({ ...note, visibility: 'specified', visibleUserIds: ['follower'] }, facts)).toEqual(['homeTimeline:follower', 'userListTimeline:own', 'userListTimeline:allowed', 'homeTimeline:author', 'userTimeline:author']);
	expect(names({ ...note, visibility: 'specified', visibleUserIds: ['author'] }, facts)).toEqual(['userListTimeline:own', 'userTimeline:author']);
});
test('channel ignores ordinary follower/list/reply/visibility routing and uses every channel follower', () => {
	expect(planNoteTimelines({ ...note, channelId: 'channel', visibility: 'specified', replyId: 'parent', replyUserId: 'elsewhere', fileIds: ['file'] }, { ...materials, channelFollowers: ['channel-reader'] })).toEqual([
		{ name: 'channelTimeline:channel', maxlen: 1000 }, { name: 'userTimelineWithChannel:author', maxlen: 300 },
		{ name: 'homeTimeline:channel-reader', maxlen: 301 }, { name: 'homeTimelineWithFiles:channel-reader', maxlen: 150.5 },
	]);
});
test('remote authors use remote maxima, no own home or local timelines', () => {
	expect(names({ ...note, userHost: 'remote.test' })).toEqual(['homeTimeline:follower', 'homeTimeline:reply-lover', 'userListTimeline:list', 'userTimeline:author']);
	expect(planNoteTimelines({ ...note, userHost: 'remote.test' }, materials).at(-1)).toEqual({ name: 'userTimeline:author', maxlen: 100 });
});
test('home visibility skips local but preserves the author cache', () => {
	expect(names({ ...note, visibility: 'home' })).not.toContain('localTimeline');
	expect(names({ ...note, visibility: 'home' })).toContain('userTimeline:author');
});
test('hibernation shuffles a copy and samples at most 1000 followers', () => {
	const all = Array.from({ length: 1003 }, (_, i) => `f${i}`);
	const original = [...all];
	const sample = sampleTimelineFollowers(all, () => 0);
	expect(sample).toHaveLength(1000);
	expect(new Set(sample).size).toBe(1000);
	expect(sample[0]).toBe('f1');
	expect(all).toEqual(original);
	expect(sampleTimelineFollowers([], () => 0)).toEqual([]);
});
