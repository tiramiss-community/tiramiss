/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { In, IsNull } from 'typeorm';
import { MiEmoji } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { ApEmojiFacts } from '../../modules/federation/public.js';

// Upstream reads a Redis/memory Map. Direct reads have different freshness and cache-hit failure behavior (#217).
export function createLocalEmojiReader(manager: EntityManager): (names: readonly string[]) => Promise<ApEmojiFacts[]> {
	return async names => {
		if (names.length === 0) {
			return [];
		}
		const emojis = await manager.getRepository(MiEmoji).findBy({ host: IsNull(), name: In([...names]) });
		return names.flatMap(name => emojis.filter(emoji => emoji.name === name).map(emoji => ({
			name: emoji.name,
			type: emoji.type,
			publicUrl: emoji.publicUrl,
			originalUrl: emoji.originalUrl,
			license: emoji.license,
			localOnly: emoji.localOnly,
			updatedAtMs: emoji.updatedAt?.getTime() ?? null,
		})));
	};
}
