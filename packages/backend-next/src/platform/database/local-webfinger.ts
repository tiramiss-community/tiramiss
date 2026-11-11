/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser } from 'backend-upstream/entities';
import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { LocalWebfingerFacts, LocalWebfingerQuery } from '../../modules/federation/public.js';

export function createLocalWebfingerReader(manager: EntityManager): (query: LocalWebfingerQuery) => Promise<LocalWebfingerFacts | null> {
	return async query => {
		const row = await manager.getRepository(MiUser).findOne({
			where: { ...query, host: IsNull(), isSuspended: false },
			select: { id: true, username: true },
		});
		return row ? { id: row.id, username: row.username } : null;
	};
}
