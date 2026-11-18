/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { nodeInfoLinks, renderNodeInfo } from '../modules/nodeinfo/public.js';
import type { NodeInfoSettings } from '../modules/nodeinfo/public.js';
import type { Logger } from '../platform/logger.js';

export function createNodeInfoApi(parts: {
	selfUrl: string;
	softwareVersion: string;
	clock(): number;
	federationEnabled(): Promise<boolean>;
	readNotes(): Promise<number>;
	readUsers(): Promise<number>;
	readSettings(): Promise<NodeInfoSettings>;
	readProxyAccountName(): Promise<string>;
	logger: Pick<Logger, 'error'>;
}) {
	let cached: { at: number; document: ReturnType<typeof renderNodeInfo> } | undefined;
	const app = new Hono().get('/.well-known/nodeinfo', async c => {
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			return c.json({ links: nodeInfoLinks(parts.selfUrl) }, 200, { 'Content-Type': 'application/json; charset=utf-8' });
		} catch {
			parts.logger.error('nodeinfo.failed', { classification: 'unexpected-failure', stage: 'discovery-meta-read' });
			return c.body(null, 500);
		}
	});
	for (const version of ['2.1', '2.0'] as const) {
		app.get(`/nodeinfo/${version}`, async c => {
			let stage = 'notes-read';
			try {
				if (cached && parts.clock() - cached.at > 600000) {
					cached = undefined;
				}
				let base = cached?.document;
				if (base === undefined) {
					const localPosts = await parts.readNotes();
					stage = 'users-read';
					const users = await parts.readUsers();
					stage = 'meta-read';
					const settings = await parts.readSettings();
					stage = 'proxy-read';
					const proxyAccountName = await parts.readProxyAccountName();
					base = renderNodeInfo({ version, softwareVersion: parts.softwareVersion, settings, localPosts, users, proxyAccountName });
					cached = { at: parts.clock(), document: base };
				}
				// The pinned endpoints mutate the same cached object; later 2.1 reads
				// retain the first fill's homepage and a preceding 2.0's deletion.
				if (version === '2.0') {
					delete base.software.repository;
				}
				return c.json({ version, ...base }, 200, {
					'Content-Type': `application/json; profile="http://nodeinfo.diaspora.software/ns/schema/${version}#"; charset=utf-8`,
					'Cache-Control': 'public, max-age=600',
					'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
					'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Vary',
				});
			} catch {
				parts.logger.error('nodeinfo.failed', { classification: 'unexpected-failure', stage });
				return c.body(null, 500);
			}
		});
	}
	return app;
}
