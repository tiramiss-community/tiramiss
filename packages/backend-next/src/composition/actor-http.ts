/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createLocalActorMaterialsReader } from './local-actor-materials.js';
import { createLocalActorTagReader } from './local-actor-tags.js';
import { createActivityPubActorApi } from '../http/activitypub-actor-api.js';
import { createHostRules } from '../modules/federation/public.js';
import { createActorReader } from '../platform/database/local-actors.js';
import { readMeta } from '../platform/database/meta.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
export function createActorHttp(resources: RuntimeResources, config: RuntimeConfig) {
	return createActivityPubActorApi({
		readTags: createLocalActorTagReader(resources.dataSource.manager, config.url),
		readActor: createActorReader(resources.dataSource.manager),
		readMaterials: createLocalActorMaterialsReader(resources.dataSource.manager, config),
		federationEnabled: async () => (await readMeta(resources.dataSource.manager)).federation !== 'none',
		isSelfHost: createHostRules(new URL(config.url).host).isSelfHost,
		publicKey: async id => resources.federationKeys.toSpkiPublicKeyPem((await resources.federationKeys.readUserKeypair(id)).publicKeyPem), selfUrl: config.url,
	});
}
