/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser, MiFollowing, MiFollowRequest, MiBlocking, MiMuting, MiRenoteMuting } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { UserRelationReader, UserFollowing } from '../../modules/user-relation/public.js';

export function createUserRelationStore(manager: EntityManager) {
	const reader: UserRelationReader = {
		async read(viewerId) {
			const [following, followedBy, requestsFromYou, requestsToYou, blocking, blockedBy, muted, renoteMuted] = await Promise.all([
				manager.getRepository(MiFollowing).findBy({ followerId: viewerId }),
				manager.getRepository(MiFollowing).find({ where: { followeeId: viewerId }, select: { followerId: true } }),
				manager.getRepository(MiFollowRequest).find({ where: { followerId: viewerId }, select: { followeeId: true } }),
				manager.getRepository(MiFollowRequest).find({ where: { followeeId: viewerId }, select: { followerId: true } }),
				manager.getRepository(MiBlocking).find({ where: { blockerId: viewerId }, select: { blockeeId: true } }),
				manager.getRepository(MiBlocking).find({ where: { blockeeId: viewerId }, select: { blockerId: true } }),
				manager.getRepository(MiMuting).find({ where: { muterId: viewerId }, select: { muteeId: true } }),
				manager.getRepository(MiRenoteMuting).find({ where: { muterId: viewerId }, select: { muteeId: true } }),
			]);
			return {
				following: following.map((row): UserFollowing => ({ id: row.id, followeeId: row.followeeId, followerId: row.followerId, isFollowerHibernated: row.isFollowerHibernated, withReplies: row.withReplies, notify: row.notify, followerHost: row.followerHost, followerInbox: row.followerInbox, followerSharedInbox: row.followerSharedInbox, followeeHost: row.followeeHost, followeeInbox: row.followeeInbox, followeeSharedInbox: row.followeeSharedInbox })),
				followedBy: followedBy.map(row => row.followerId), requestsFromYou: requestsFromYou.map(row => row.followeeId), requestsToYou: requestsToYou.map(row => row.followerId),
				blocking: blocking.map(row => row.blockeeId), blockedBy: blockedBy.map(row => row.blockerId), muted: muted.map(row => row.muteeId), renoteMuted: renoteMuted.map(row => row.muteeId),
			};
		},
	};
	return {
		reader,
		async readActor(userId: string) {
			const user = await manager.getRepository(MiUser).findOneByOrFail({ id: userId });
			return { isSuspended: user.isSuspended, isModerator: false, isAdministrator: false };
		},
	};
}
