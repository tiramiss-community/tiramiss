/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiFollowing, MiNote, MiNoteFavorite, MiNoteThreadMuting, MiUser } from 'backend-upstream/entities';
import { evaluatePolicies, selectApplicableRoles } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';
import type { NotePersonalStatePorts } from '../../modules/note-personal-state/public.js';

export function createNotePersonalStateStore(manager: EntityManager, createdAtFromId: (id: string) => number): Omit<NotePersonalStatePorts, 'limit' | 'newId' | 'startAchievement'> {
	const favorites = manager.getRepository(MiNoteFavorite);
	const mutings = manager.getRepository(MiNoteThreadMuting);
	return {
		async readActor(id, now) {
			const facts = await readRoleAuthorizationFacts(manager, id, createdAtFromId);
			const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
			const policies = evaluatePolicies({ userId: id, roles, basePolicies: facts.instance.basePolicies, uploadLimitBytes: 0 });
			const user = await manager.getRepository(MiUser).findOneByOrFail({ id });
			return { isSuspended: user.isSuspended, isModerator: false, isAdministrator: false, movedToUri: user.movedToUri, rateLimitFactor: policies.rateLimitFactor };
		},
		readNote: id => manager.getRepository(MiNote).findOne({ where: { id }, select: { id: true, threadId: true, userId: true, userHost: true, visibility: true, visibleUserIds: true, replyUserId: true, mentions: true } }),
		isFollowing: (userId, authorId) => manager.getRepository(MiFollowing).existsBy({ followerId: userId, followeeId: authorId }),
		hasFavorite: (userId, noteId) => favorites.existsBy({ userId, noteId }),
		readFavorite: (userId, noteId) => favorites.findOne({ where: { userId, noteId }, select: { id: true } }),
		hasThreadMute: (userId, threadId) => mutings.existsBy({ userId, threadId }),
		async insertFavorite(row) {
 await favorites.insert(row); 
},
		async deleteFavorite(id) {
 await favorites.delete(id); 
},
		async insertThreadMute(row) {
 await mutings.insert(row); 
},
		async deleteThreadMute(userId, threadId) {
 await mutings.delete({ userId, threadId }); 
},
	};
}
