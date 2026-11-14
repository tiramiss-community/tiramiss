/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull } from 'typeorm';
import { MiEmoji } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { ApEmojiFacts } from '../../modules/federation/public.js';

export function createLocalEmojiObjectReader(manager: EntityManager): (name: string) => Promise<ApEmojiFacts | null> {
	return async name => {
		const emoji = await manager.getRepository(MiEmoji).findOneBy({ host: IsNull(), name });
		return emoji === null ? null : {
			name: emoji.name, type: emoji.type, publicUrl: emoji.publicUrl,
			originalUrl: emoji.originalUrl, license: emoji.license, localOnly: emoji.localOnly,
			updatedAtMs: emoji.updatedAt?.getTime() ?? null,
		};
	};
}
