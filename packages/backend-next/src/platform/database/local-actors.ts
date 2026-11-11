/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser, MiUserProfile } from 'backend-upstream/entities';
import type { LocalActorProfileFacts } from '../../modules/federation/public.js';
import type { EntityManager } from 'typeorm';
export function createActorReader(manager: EntityManager, options: {
	includeSuspended?: boolean;
} = {}) {
	return async (id: string) => {
		const row = await manager.getRepository(MiUser).findOneBy(options.includeSuspended ? { id } : { id, isSuspended: false });
		if (!row) {
			return null;
		}
		const { username, name, isBot, isLocked, isExplorable, emojis, tags, host, uri } = row;
		return { id, username, name, isBot, isLocked, isExplorable, emojis, tags, host, uri };
	};
}

export function createActorProfileReader(manager: EntityManager): (id: string) => Promise<LocalActorProfileFacts> {
	return async id => {
		const { description, followedMessage, fields, birthday, location } = await manager.getRepository(MiUserProfile).findOneOrFail({
			where: { userId: id }, select: { description: true, followedMessage: true, fields: true, birthday: true, location: true },
		});
		return { description, followedMessage, fields, birthday, location };
	};
}
