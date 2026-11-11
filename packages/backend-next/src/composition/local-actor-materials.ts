/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createActorFileReader, createActorProfileReader } from '../platform/database/local-actors.js';
import { readMeta } from '../platform/database/meta.js';
import type { LocalActorFacts, LocalActorMaterials } from '../modules/federation/public.js';
import type { RuntimeConfig } from '../config/types.js';
import type { EntityManager } from 'typeorm';

export function createLocalActorMaterialsReader(manager: EntityManager, config: RuntimeConfig): (user: LocalActorFacts) => Promise<LocalActorMaterials> {
	const readFile = createActorFileReader(manager);
	const readProfile = createActorProfileReader(manager);
	const mediaProxy = config.noteMedia?.mediaProxy ?? `${new URL(config.url).origin}/proxy`;
	const externalMediaProxyEnabled = config.noteMedia?.externalMediaProxyEnabled ?? false;
	return async user => {
		const [avatar, banner, profile] = await Promise.all([
			user.avatarId ? readFile(user.avatarId) : null,
			user.bannerId ? readFile(user.bannerId) : null,
			readProfile(user.id),
		]);
		// Upstream injects in-memory Meta; this composition reads its current DB state.
		const { iconUrl, bannerUrl, proxyRemoteFiles } = await readMeta(manager);
		return { profile, media: { avatar, banner, iconUrl, bannerUrl, proxyRemoteFiles, mediaProxy, externalMediaProxyEnabled } };
	};
}
