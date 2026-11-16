/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createLocalActorMaterialsReader } from './local-actor-materials.js';
import { createLocalActorTagReader } from './local-actor-tags.js';
import { createActivityPubActorAliasKeyApi } from '../http/activitypub-actor-api.js';
import { createHostRules } from '../modules/federation/public.js';
import { createActorReader, createAcctActorReader, createLocalKeyOwnerReader } from '../platform/database/local-actors.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
export function createActorHttp(resources: RuntimeResources, config: RuntimeConfig) {
	return createActivityPubActorAliasKeyApi({
		readTags: createLocalActorTagReader(resources.dataSource.manager, config.url, Date.now, resources.actorEmojis?.local),
		readActor: createActorReader(resources.dataSource.manager),
		readActorByAcct: createAcctActorReader(resources.dataSource.manager),
		readKeyOwner: createLocalKeyOwnerReader(resources.dataSource.manager),
		production: process.env.NODE_ENV === 'production',
		allowExternalApRedirect: async () => (await resources.meta.fetch()).allowExternalApRedirect,
		readMaterials: createLocalActorMaterialsReader(resources.dataSource.manager, config, resources.meta.fetch),
		federationEnabled: async () => (await resources.meta.fetch()).federation !== 'none',
		isSelfHost: createHostRules(new URL(config.url).host).isSelfHost,
		readPublicKey: async id => (await resources.federationKeys.readUserKeypair(id)).publicKeyPem,
		toSpki: pem => resources.federationKeys.toSpkiPublicKeyPem(pem),
		publicKey: async id => resources.federationKeys.toSpkiPublicKeyPem((await resources.federationKeys.readUserKeypair(id)).publicKeyPem), selfUrl: config.url,
	});
}
