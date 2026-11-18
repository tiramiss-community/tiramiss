/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote, MiPromoNote } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { PromoPorts } from '../../modules/promo/public.js';

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
