/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { renderHostMetaXrd } from '../modules/federation/public.js';
import type { Logger } from '../platform/logger.js';

export function createWellKnownApi(parts: {
	selfUrl: string;
	logger: Pick<Logger, 'error'>;
	federationEnabled(): Promise<boolean>;
}): Hono {
	const app = new Hono();
	app.use('/.well-known/*', async (c, next) => {
		await next();
		// Fastify's encapsulated hook runs for registered routes, including wildcard
		// OPTIONS, but its global unmatched-route response has no discovery CORS.
		if (c.req.path.startsWith('/.well-known/') && c.req.matchedRoutes.some(route => route.method !== 'ALL' && route.path.startsWith('/.well-known/'))) {
			c.header('Access-Control-Allow-Headers', 'Accept');
			c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Expose-Headers', 'Vary');
		}
	});
	// Hono also matches the bare prefix; Fastify requires the trailing slash.
	app.options('/.well-known/*', c => c.req.path.startsWith('/.well-known/') ? c.body(null, 204) : c.notFound());
	for (const path of ['/.well-known/host-meta', '/.well-known/host-meta.json']) {
		app.get(path, async c => {
			try {
				if (!await parts.federationEnabled()) {
					return c.body(null, 403);
				}
				if (path.endsWith('.json')) {
					return c.json({ links: [{ rel: 'lrdd', type: 'application/jrd+json', template: `${parts.selfUrl}/.well-known/webfinger?resource={uri}` }] }, 200, { 'Content-Type': 'application/json; charset=utf-8' });
				}
				c.header('Content-Type', 'application/xrd+xml');
				return c.body(renderHostMetaXrd(parts.selfUrl));
			} catch {
				parts.logger.error('host-meta.failed', { classification: 'unexpected-failure', stage: 'meta-read' });
				return c.body(null, 500);
			}
		});
	}
	return app;
}
