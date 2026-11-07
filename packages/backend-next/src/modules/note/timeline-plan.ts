/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NewNote } from './create-contract.js';

export type TimelineNote = Pick<NewNote, 'id' | 'userId' | 'userHost' | 'visibility' | 'visibleUserIds' | 'replyId' | 'replyUserId' | 'replyUserHost' | 'channelId' | 'fileIds'>;

export interface TimelineMaterials {
	limits: { localUser: number; remoteUser: number; home: number; list: number; channel: number };
	followers: { followerId: string; withReplies: boolean }[];
	lists: { userListId: string; userListUserId: string; withReplies: boolean }[];
	channelFollowers: string[];
}

export interface PlannedTimeline {
	name: string;
	maxlen: number;
}

export function planNoteTimelines(note: TimelineNote, materials: TimelineMaterials): PlannedTimeline[] {
	const { limits } = materials;
	const planned: PlannedTimeline[] = [];
	const push = (name: string, maxlen: number) => planned.push({ name, maxlen });
	const withFiles = (name: string, maxlen: number) => {
		push(name, maxlen);
		if (note.fileIds.length > 0) {
			const [kind, id] = name.split(':');
			push(`${kind}WithFiles:${id}`, maxlen / 2);
		}
	};
	const isReply = (viewerId?: string) => Boolean(note.replyId && note.replyUserId !== note.userId && note.replyUserId !== viewerId);
	const userMax = note.userHost === null ? limits.localUser : limits.remoteUser;

	if (note.channelId) {
		push(`channelTimeline:${note.channelId}`, limits.channel);
		push(`userTimelineWithChannel:${note.userId}`, userMax);
		for (const followerId of materials.channelFollowers) {
			withFiles(`homeTimeline:${followerId}`, limits.home);
		}
		return planned;
	}

	const followerIds = new Set(materials.followers.map(follower => follower.followerId));
	const visible = new Set(note.visibleUserIds);
	for (const follower of materials.followers) {
		if (note.visibility === 'specified' && !visible.has(follower.followerId)) {
			continue;
		}
		if (isReply(follower.followerId) && !follower.withReplies) {
			continue;
		}
		withFiles(`homeTimeline:${follower.followerId}`, limits.home);
	}
	for (const list of materials.lists) {
		if (note.visibility === 'followers' && list.userListUserId !== note.userId && !followerIds.has(list.userListUserId)) {
			continue;
		}
		if (note.visibility === 'specified' && list.userListUserId !== note.userId && !visible.has(list.userListUserId)) {
			continue;
		}
		if (isReply(list.userListUserId) && !list.withReplies) {
			continue;
		}
		withFiles(`userListTimeline:${list.userListId}`, limits.list);
	}
	// 本家はspecifiedで作者自身がvisibleUserIdsに入っている場合、ここでは追加しない。
	if (note.userHost === null && (note.visibility !== 'specified' || !visible.has(note.userId))) {
		withFiles(`homeTimeline:${note.userId}`, limits.home);
	}

	if (isReply()) {
		push(`userTimelineWithReplies:${note.userId}`, userMax);
		if (note.visibility === 'public' && note.userHost === null) {
			push('localTimelineWithReplies', 300);
			if (note.replyUserHost === null) {
				push(`localTimelineWithReplyTo:${note.replyUserId}`, 30);
			}
		}
	} else {
		withFiles(`userTimeline:${note.userId}`, userMax);
		if (note.visibility === 'public' && note.userHost === null) {
			push('localTimeline', 1000);
			if (note.fileIds.length > 0) {
				push('localTimelineWithFiles', 500);
			}
		}
	}
	return planned;
}

export function sampleTimelineFollowers(followerIds: string[], random: () => number): string[] {
	const shuffled = [...followerIds];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled.slice(0, 1000);
}
