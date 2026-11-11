/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { renderApEmoji, renderApHashtag } from '../modules/federation/public.js';
import { createLocalEmojiReader } from '../platform/database/local-emojis.js';
import type { LocalActorFacts, LocalActorTag } from '../modules/federation/public.js';
import type { EntityManager } from 'typeorm';

export function createLocalActorTagReader(manager: EntityManager, selfUrl: string, now: () => number = Date.now): (user: Pick<LocalActorFacts, 'emojis' | 'tags'>) => Promise<LocalActorTag[]> {
	const readEmojis = createLocalEmojiReader(manager);
	return async user => {
		const emojis = await readEmojis(user.emojis);
		return [
			...emojis.filter(emoji => !emoji.localOnly).map(emoji => renderApEmoji(emoji, selfUrl, emoji.updatedAtMs ?? now())),
			...user.tags.map(name => renderApHashtag(name, selfUrl)),
		];
	};
}
