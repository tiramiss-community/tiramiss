/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiRelay } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';

export function createAcceptedRelayReader(options: { manager: EntityManager; currentTime(): number }): () => Promise<readonly { inbox: string }[]> {
	let cached: readonly { inbox: string }[] | undefined;
	let cachedAt = 0;
	return async () => {
		if (cached !== undefined && options.currentTime() - cachedAt <= 600000) {
			return cached;
		}
		const relays = await options.manager.getRepository(MiRelay).findBy({ status: 'accepted' });
		cached = relays;
		cachedAt = options.currentTime();
		return relays;
	};
}
