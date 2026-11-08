/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
export function createActorReader(manager: EntityManager, options: {
	includeSuspended?: boolean;
} = {}) {
	return async (id: string) => {
		const row = await manager.getRepository(MiUser).findOneBy(options.includeSuspended ? { id } : { id, isSuspended: false });
		if (!row) {
			return null;
		}
		const { username, name, isBot, isLocked, isExplorable, host, uri } = row;
		return { id, username, name, isBot, isLocked, isExplorable, host, uri };
	};
}
