/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote, MiPromoNote, MiPromoRead, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import { AuthenticationFailed } from '../../modules/access/public.js';
import type { PromoPorts, PromoReadPorts } from '../../modules/promo/public.js';

export function createPromoStore(manager: EntityManager): Omit<PromoPorts, 'readActor'> {
	const promos = manager.getRepository(MiPromoNote);
	return {
		readNote: id => manager.getRepository(MiNote).findOne({ where: { id }, select: { id: true, userId: true } }),
		exists: noteId => promos.existsBy({ noteId }),
		async insert(row) {
			await promos.insert(row);
		},
	};
}

export function createPromoReadStore(manager: EntityManager): Omit<PromoReadPorts, 'newId'> {
	const reads = manager.getRepository(MiPromoRead);
	return {
		async readActor(userId) {
			const user = await manager.getRepository(MiUser).findOne({ where: { id: userId }, select: { isSuspended: true } });
			if (user === null) {
				throw new AuthenticationFailed();
			}
			return { isSuspended: user.isSuspended, isModerator: false, isAdministrator: false };
		},
		noteExists: id => manager.getRepository(MiNote).existsBy({ id }),
		readExists: (noteId, userId) => reads.existsBy({ noteId, userId }),
		async insertRead(row) {
			await reads.insert(row);
		},
	};
}
