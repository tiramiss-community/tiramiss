/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull } from 'typeorm';
import { MiEmoji, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { AvatarImageReader } from '../../modules/avatar-images/public.js';

export function createAvatarImageReader(manager: EntityManager): AvatarImageReader {
	return {
		emoji: (name, host) => manager.getRepository(MiEmoji).findOneBy({ name, host: host ?? IsNull() }),
		user: (usernameLower, host) => manager.getRepository(MiUser).findOne({ where: { usernameLower, host: host ?? IsNull(), isSuspended: false } }),
	};
}
