/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser, MiNote } from 'backend-upstream/entities';
import { evaluatePolicies, selectApplicableRoles } from '../../modules/role/public.js';
import { readMeta } from './meta.js';
import type { EntityManager } from 'typeorm';
import type { NewTextNote, NoteCreateAuthor } from '../../modules/note/public.js';
import type { RoleMaterialReader } from '../role-material-cache.js';

export function createNoteWriter(manager: EntityManager, roles: RoleMaterialReader, createdAtFromId: (id: string) => number) {
	return {
		async readAuthor(id: string, now: number): Promise<NoteCreateAuthor | null> {
			const user = await manager.getRepository(MiUser).findOneBy({ id });
			if (!user || user.host !== null) {
				return null;
			}
			const [meta, definitions, assignments] = await Promise.all([
				readMeta(manager), roles.readRoles(), roles.readAssignments(id),
			]);
			const applicable = selectApplicableRoles(definitions, assignments, {
				userId: id, host: user.host, createdAtMs: createdAtFromId(id), isSuspended: user.isSuspended,
				isLocked: user.isLocked, isBot: user.isBot, isCat: user.isCat, isExplorable: user.isExplorable,
				followersCount: user.followersCount, followingCount: user.followingCount, notesCount: user.notesCount,
			}, now);
			const policies = evaluatePolicies({ userId: id, roles: applicable, basePolicies: meta.policies, uploadLimitBytes: 0 });
			return { id, isSuspended: user.isSuspended, movedToUri: user.movedToUri, canPublicNote: policies.canPublicNote,
												rateLimitFactor: policies.rateLimitFactor, sensitiveWords: meta.sensitiveWords, prohibitedWords: meta.prohibitedWords };
		},
		async insert(note: NewTextNote): Promise<void> {
			await manager.getRepository(MiNote).insert({ ...note, userHost: null });
		},
	};
}
