/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull, LessThan } from 'typeorm';
import { MiFollowing, MiUser, MiUserProfile } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { FollowCollectionReader } from '../../modules/federation/public.js';

export function createFollowCollectionReader(manager: EntityManager): FollowCollectionReader {
	return {
		async readLocalUser(id) {
			const user = await manager.getRepository(MiUser).findOne({
				where: { id, host: IsNull() }, select: { id: true, followersCount: true, followingCount: true },
			});
			return user === null ? null : { id: user.id, followersCount: user.followersCount, followingCount: user.followingCount };
		},
		async readVisibility(id, direction) {
			const profile = await manager.getRepository(MiUserProfile).findOneByOrFail({ userId: id });
			return direction === 'followers' ? profile.followersVisibility : profile.followingVisibility;
		},
		async readRelations(id, direction, cursor) {
			const rows = await manager.getRepository(MiFollowing).find({
				where: { ...(direction === 'followers' ? { followeeId: id } : { followerId: id }), ...(cursor ? { id: LessThan(cursor) } : {}) },
				take: 11, order: { id: 'DESC' },
			});
			return rows.map(row => ({ id: row.id, memberId: direction === 'followers' ? row.followerId : row.followeeId }));
		},
		async readMember(id) {
			const user = await manager.getRepository(MiUser).findOneByOrFail({ id });
			return { id: user.id, host: user.host, uri: user.uri };
		},
	};
}
