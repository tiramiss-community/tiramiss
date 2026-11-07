/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull, LessThan } from 'typeorm';
import { MiChannelFollowing, MiFollowing, MiNote, MiUser, MiUserListMembership } from 'backend-upstream/entities';
import { readMeta } from './meta.js';
import type { EntityManager } from 'typeorm';
import type { TimelineMaterials, TimelineNote } from '../../modules/note/public.js';

export function createNoteTimelineReader(manager: EntityManager, channelMax: number) {
	return {
		async settings(): Promise<{ enabled: boolean; limits: TimelineMaterials['limits'] }> {
			const meta = await readMeta(manager);
			return { enabled: meta.enableFanoutTimeline, limits: {
				localUser: meta.perLocalUserUserTimelineCacheMax, remoteUser: meta.perRemoteUserUserTimelineCacheMax,
				home: meta.perUserHomeTimelineCacheMax, list: meta.perUserListTimelineCacheMax, channel: channelMax,
			} };
		},
		note(id: string): Promise<TimelineNote | null> {
			return manager.getRepository(MiNote).findOne({ where: { id }, select: {
				id: true, userId: true, userHost: true, visibility: true, visibleUserIds: true, replyId: true,
				replyUserId: true, replyUserHost: true, channelId: true, fileIds: true,
			} });
		},
		async followers(userId: string): Promise<TimelineMaterials['followers']> {
			return manager.getRepository(MiFollowing).find({ where: { followeeId: userId, followerHost: IsNull(), isFollowerHibernated: false }, select: { followerId: true, withReplies: true } });
		},
		async lists(userId: string): Promise<TimelineMaterials['lists']> {
			return manager.getRepository(MiUserListMembership).find({ where: { userId }, select: { userListId: true, userListUserId: true, withReplies: true } });
		},
		async channelFollowers(channelId: string): Promise<string[]> {
			const rows = await manager.getRepository(MiChannelFollowing).find({ where: { followeeId: channelId }, select: { followerId: true } });
			return rows.map(row => row.followerId);
		},
		async hibernate(followerIds: string[], now: number): Promise<void> {
			if (followerIds.length === 0) {
				return;
			}
			const users = await manager.getRepository(MiUser).find({
				where: { id: In(followerIds), lastActiveDate: LessThan(new Date(now - 50 * 86400000)) }, select: { id: true },
			});
			if (users.length === 0) {
				return;
			}
			const ids = users.map(user => user.id);
			// 本家の二つの更新は独立している。片方の失敗でももう片方を省略せず、開始した両方を待つ。
			const results = await Promise.allSettled([
				manager.getRepository(MiUser).update({ id: In(ids) }, { isHibernated: true }),
				manager.getRepository(MiFollowing).update({ followerId: In(ids) }, { isFollowerHibernated: true }),
			]);
			const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
			if (errors.length > 0) {
				throw new AggregateError(errors, 'Timeline follower hibernation failed');
			}
		},
	};
}
