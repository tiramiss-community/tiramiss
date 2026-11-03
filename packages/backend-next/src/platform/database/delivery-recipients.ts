/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull, Not } from 'typeorm';
import { MiFollowing, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { DeliveryUser, FollowerInbox } from '../../modules/federation/public.js';

/** 本家 DeliverManager と NoteCreateService が宛先を決めるために読む行。 */
export function createDeliveryRecipientReader(manager: EntityManager) {
	return {
		async readUsers(ids: readonly string[]): Promise<DeliveryUser[]> {
			if (ids.length === 0) {
				return [];
			}
			const users = await manager.getRepository(MiUser).find({
				where: { id: In([...ids]) },
				select: { id: true, host: true, inbox: true, sharedInbox: true },
			});
			return users.map(user => ({ id: user.id, host: user.host, inbox: user.inbox, sharedInbox: user.sharedInbox }));
		},

		// 本家と同じく順序を指定しない。休眠中のフォロワーも除かない。
		// 主キーを選ばないため、TypeORM は選んだ 2 列がともに null の行を返さない。本家も同じ問い合わせなので、
		// inbox のないフォロワーは `inbox is null` にならずに飛ばされる。主キーを足すとこの結果が本家と変わる。
		async readFollowerInboxes(followeeId: string): Promise<FollowerInbox[]> {
			const followings = await manager.getRepository(MiFollowing).find({
				where: { followeeId, followerHost: Not(IsNull()) },
				select: { followerSharedInbox: true, followerInbox: true },
			});
			return followings.map(following => ({ followerSharedInbox: following.followerSharedInbox, followerInbox: following.followerInbox }));
		},
	};
}
