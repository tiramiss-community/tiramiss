/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser, MiUserMemo } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { UserMemoPorts, UserMemoReader } from '../../modules/user-memo/public.js';

export function createUserMemoStore(manager: EntityManager): Omit<UserMemoPorts, 'newId'> {
	const users = manager.getRepository(MiUser);
	const memos = manager.getRepository(MiUserMemo);
	return {
		async readActor(userId) {
			const user = await users.findOneByOrFail({ id: userId });
			return { isSuspended: user.isSuspended, isModerator: false, isAdministrator: false };
		},
		targetExists: userId => users.existsBy({ id: userId }),
		readPrevious: (userId, targetUserId) => memos.findOne({ where: { userId, targetUserId }, select: { id: true } }),
		async insert(row) {
			await memos.insert(row);
		},
		async update(row) {
			await memos.update(row.id, { userId: row.userId, targetUserId: row.targetUserId, memo: row.memo });
		},
		async delete(userId, targetUserId) {
			await memos.delete({ userId, targetUserId });
		},
	};
}

export function createUserMemoReader(manager: EntityManager): UserMemoReader {
	const memos = manager.getRepository(MiUserMemo);
	return {
		async read(viewerId, targetUserId) {
			if (viewerId === null) {
				return null;
			}
			return (await memos.findOne({ where: { userId: viewerId, targetUserId }, select: { memo: true } }))?.memo ?? null;
		},
	};
}
