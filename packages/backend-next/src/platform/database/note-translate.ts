/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiFollowing, MiUser } from 'backend-upstream/entities';
import { AuthenticationFailed } from '../../modules/access/public.js';
import { evaluatePolicies, selectApplicableRoles } from '../../modules/role/public.js';
import { readRoleAuthorizationFacts } from './role-authorization-facts.js';
import type { EntityManager } from 'typeorm';
import type { NoteTranslationPorts } from '../../modules/note-translate/public.js';

export function createNoteTranslationReader(manager: EntityManager, createdAtFromId: (id: string) => number): Pick<NoteTranslationPorts, 'readActor' | 'canUseTranslator' | 'isFollowing'> {
	return {
		async readActor(userId) {
			const user = await manager.getRepository(MiUser).findOneBy({ id: userId });
			if (!user) {
				throw new AuthenticationFailed();
			}
			return { id: user.id, host: user.host, isSuspended: user.isSuspended, isModerator: false, isAdministrator: false };
		},
		async canUseTranslator(userId, now) {
			const facts = await readRoleAuthorizationFacts(manager, userId, createdAtFromId);
			const roles = selectApplicableRoles(facts.roles, facts.assignments, facts.user, now);
			return evaluatePolicies({ userId, roles, basePolicies: facts.instance.basePolicies, uploadLimitBytes: 0 }).canUseTranslator;
		},
		isFollowing: (followerId, followeeId) => manager.getRepository(MiFollowing).existsBy({ followerId, followeeId }),
	};
}
