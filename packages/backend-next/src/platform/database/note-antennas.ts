/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiAntenna, MiFollowing, MiUserListMembership } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AntennaDefinition } from '../../modules/note/public.js';
export function antennaDefinition(row: AntennaDefinition): AntennaDefinition {
	const { id, userId, src, userListId, users, keywords, excludeKeywords, caseSensitive, excludeBots, withReplies, withFile, isActive, localOnly, excludeNotesInSensitiveChannel } = row;
	return {
		id, userId, src, userListId, users, keywords, excludeKeywords, caseSensitive, excludeBots, withReplies, withFile, isActive, localOnly, excludeNotesInSensitiveChannel
	};
}
export function createNoteAntennaReader(manager: EntityManager) {
	return {
		async active(): Promise<AntennaDefinition[]> {
			return (await manager.getRepository(MiAntenna).findBy({ isActive: true })).map(antennaDefinition);
		},
		async followings(ownerId: string): Promise<{
			followeeId: string;
			withReplies: boolean;
		}[]> {
			return (await manager.getRepository(MiFollowing).find({ where: { followerId: ownerId }, select: { followeeId: true, withReplies: true } })).map(({ followeeId, withReplies }) => ({ followeeId, withReplies }));
		},
		listContains(userListId: string, userId: string): Promise<boolean> {
			return manager.getRepository(MiUserListMembership).existsBy({ userListId, userId });
		},
	};
}
