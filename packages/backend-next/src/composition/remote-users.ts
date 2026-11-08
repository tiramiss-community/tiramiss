/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { htmlToMfm, apType, webfingerUrl, selectWebfingerSelf, createActivitySession, createHostRules, isFederationAllowedHost, toPuny, punyHost, validateActor, prepareActor, collectionVisibility, insertActor, truncate } from '../modules/federation/public.js';
import { createRemoteUserRepository, createRemoteActorTransactions } from '../platform/database/remote-users.js';
import { createActorReader } from '../platform/database/local-actors.js';
import { readMeta, readFederationPolicy } from '../platform/database/meta.js';
import { renderLocalActor } from '../modules/federation/public.js';
import type { DataSource } from 'typeorm';
import type { FederationKeys } from './federation-keys.js';
import type { OutboundHttp, OutboundSend } from '../application/outbound-http.js';
import type { RemoteUserPorts } from '../modules/federation/public.js';
import type { RuntimeConfig } from '../config/types.js';
export function createRemoteUsers(parts: {
	dataSource: DataSource;
	federationKeys: FederationKeys;
	outboundHttp: OutboundHttp;
}, config: RuntimeConfig): RemoteUserPorts {
	const selfAuthority = punyHost(config.url);
	// Transport policy uses DNS hostnames: a nondefault port must not collapse either side to an empty host.
	const withoutRootDot = (host: string) => host.replace(/\.$/, '');
	const requestRules = createHostRules(withoutRootDot(new URL(config.url).hostname));
	const readActor = createActorReader(parts.dataSource.manager, { includeSuspended: true });
	const readRequestPolicy = async () => {
		const current = await readFederationPolicy(parts.dataSource.manager);
		return {
			...current,
			blockedHosts: current.blockedHosts.map(withoutRootDot),
			federationHosts: current.federationHosts.map(withoutRootDot),
		};
	};
	const sendAllowed: OutboundSend = async (url, options = {}, extra) => {
		const policy = await readRequestPolicy();
		const validateUrl = (target: URL) => {
			options.validateUrl?.(target);
			if (!isFederationAllowedHost(policy, requestRules, withoutRootDot(toPuny(target.hostname)))) {
				throw new Error('Instance is blocked');
			}
		};
		validateUrl(new URL(url));
		return parts.outboundHttp.send(url, { ...options, validateUrl }, extra);
	};
	const localId = (uri: string) => {
		if (punyHost(uri) !== selfAuthority) {
			return null;
		}
		// Source AP-ID resolution uses the first user ID and permits the remaining path.
		const [, type, id] = new URL(uri).pathname.split('/');
		return type === 'users' ? id ?? null : null;
	};
	return {
		...createRemoteUserRepository(parts.dataSource.manager), selfHost: new URL(config.url).host, localId, insertActor,
		actorTransactions: createRemoteActorTransactions(parts.dataSource),
		async webfinger(account) {
			const acct = `${account.username}@${account.host}`;
			const url = webfingerUrl(acct, process.env.MISSKEY_WEBFINGER_USE_HTTP?.toLowerCase() === 'true');
			const response = await sendAllowed(url, {
				method: 'GET', headers: { Accept: 'application/jrd+json, application/json' }, timeoutMs: 5000, maxBytes: 262144,
			});
			const finger = await response.json() as {
				links: {
					rel?: string;
					href: string;
				}[];
			};
			return selectWebfingerSelf(finger);
		},
		async acquireActor(uri, existing, currentTime, newId) {
			const session = createActivitySession({
				http: { send: sendAllowed }, signed: (await readMeta(parts.dataSource.manager)).signToActivityPubGet, clock: Date.now,
				isSelfHost: authority => authority === selfAuthority,
				isAllowedHost: async host => isFederationAllowedHost(await readRequestPolicy(), requestRules, withoutRootDot(toPuny(host))),
				async signer() {
					const user = await parts.federationKeys.ensureSystemAccount('actor');
					const key = await parts.federationKeys.readUserKeypair(user.id);
					return { privateKeyPem: key.privateKeyPem, keyId: `${config.url}/users/${user.id}#main-key` };
				},
				async resolveLocal(url) {
					const id = localId(url);
					const user = id ? await readActor(id) : null;
					// Other local object families belong to their own acquisition slices.
					if (!user || user.host !== null) {
						throw new Error('local user not found');
					}
					return renderLocalActor(user, config.url, parts.federationKeys.toSpkiPublicKeyPem((await parts.federationKeys.readUserKeypair(user.id)).publicKeyPem));
				},
			});
			const material = validateActor(await session.resolve(uri), uri);
			const p = material.actor;
			material.fields = Array.isArray(p.attachment) ? p.attachment.flatMap(field => apType(field) === 'PropertyValue' && typeof field.name === 'string' && typeof field.value === 'string' ? [{ name: field.name, value: htmlToMfm(field.value) }] : []) : [];
			[material.followingVisibility, material.followersVisibility] = await Promise.all([p.following, p.followers].map(value => collectionVisibility(value, session.resolve, existing !== null)));
			const hashtagNames = (Array.isArray(p.tag) ? p.tag : p.tag ? [p.tag] : []).flatMap(tag => apType(tag) === 'Hashtag' && typeof tag.name === 'string' ? [tag.name] : []);
			try {
				material.description = p._misskey_summary ? truncate(p._misskey_summary, 2048) : p.summary ? htmlToMfm(truncate(p.summary, 2048)!, hashtagNames) : null;
			} catch (error) {
				// Source converts the description after User (and refresh Key) writes. Preserve those failure boundaries.
				material.profileError = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };
			}
			const completedAt = currentTime();
			return prepareActor(material, existing, completedAt, existing?.id ?? newId(completedAt));
		},
	};
}
