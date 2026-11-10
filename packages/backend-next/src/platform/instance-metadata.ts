/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { parse } from 'node-html-parser';
import { metadataColor, metadataDescription, metadataFavicon, metadataIcon, metadataName, metadataPatch, selectNodeInfoUrl } from '../modules/federation/public.js';
import type { Redis } from 'ioredis';
import type { OutboundHttp } from '../application/outbound-http.js';
import type { HtmlMetadata, InstanceLedger, InstanceMetadataTarget } from '../modules/federation/public.js';

function projectHtml(html: string): HtmlMetadata {
	const doc = parse(html);
	return {
		links: doc.getElementsByTagName('link').map(link => ({ rel: link.attributes.rel, href: link.attributes.href })),
		themeColor: doc.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
		name: doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
		description: doc.querySelector('meta[name="description"]')?.getAttribute('content'),
		ogDescription: doc.querySelector('meta[property="og:description"]')?.getAttribute('content'),
	};
}

export function createInstanceMetadata(ports: {
	redis: Redis;
	http: OutboundHttp;
	ledger: InstanceLedger;
	clock(): number;
	reportFailure(error: unknown, context: { host: string }): void;
}): (instance: InstanceMetadataTarget, force?: boolean) => Promise<void> {
	const { redis, http, ledger, clock } = ports;
	return async (instance, force = false) => {
		const { host } = instance;
		const key = `fetchInstanceMetadata:mutex:v2:${host}`;
		if (!force) {
			// Source starts legacy cleanup without waiting. Observe its failure without changing lock acquisition.
			void redis.del(`fetchInstanceMetadata:mutex:${host}`).catch(error => ports.reportFailure(error, { host }));
			if (await redis.set(key, '1', 'EX', 30, 'GET') === '1') {
				return;
			}
		}
		try {
			if (!force) {
				const current = await ledger.fetchOrRegisterInstance(host);
				const now = clock();
				if (current.infoUpdatedAtMs !== null && now - current.infoUpdatedAtMs < 86400000) {
					return;
				}
			}
			const [info, html, manifest] = await Promise.all([
				(async () => http.getJson(selectNodeInfoUrl(await http.getJson(`https://${host}/.well-known/nodeinfo`))))().catch(() => null),
				http.getHtml(`https://${host}`).then(projectHtml).catch(() => null),
				http.getJson(`https://${host}/manifest.json`).catch(() => null),
			]);
			const derive = async <T>(work: () => T | Promise<T>): Promise<T | null> => {
				try {
					return await work();
				} catch {
					return null;
				}
			};
			const [favicon, icon, themeColor, name, description] = await Promise.all([
				derive(async () => {
					const fromHtml = metadataFavicon(host, html);
					if (fromHtml) {
						return fromHtml;
					}
					const url = `https://${host}/favicon.ico`;
					const result = await http.send(url, { method: 'HEAD' }, { okOnly: false });
					return result.status >= 200 && result.status < 300 ? url : null;
				}),
				derive(() => metadataIcon(host, html, manifest)),
				derive(() => metadataColor(info, html, manifest)),
				derive(() => metadataName(info, html, manifest)),
				derive(() => metadataDescription(info, html, manifest)),
			]);
			await ledger.updateInstance(instance.id, metadataPatch(info, { favicon, icon, themeColor, name, description }, clock()));
		} catch (error) {
			ports.reportFailure(error, { host });
		} finally {
			// Source force/expiry races deliberately use unconditional delete rather than token ownership.
			await redis.del(key);
		}
	};
}
