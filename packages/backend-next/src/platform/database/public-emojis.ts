/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IsNull } from 'typeorm';
import { MiEmoji } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { PublicEmoji } from '../../modules/emoji/public.js';

export function createPublicEmojiReader(manager: EntityManager): { list(): Promise<PublicEmoji[]>; findLocal(name: string): Promise<PublicEmoji> } {
	const repository = manager.getRepository(MiEmoji);
	return {
		list: () => repository.find({ where: { host: IsNull() }, order: { category: 'ASC', name: 'ASC' } }),
		findLocal: name => repository.findOneOrFail({ where: { name, host: IsNull() } }),
	};
}
