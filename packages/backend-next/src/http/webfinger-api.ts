/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import { Hono } from 'hono';
import { localWebfingerQuery, renderLocalWebfinger, renderWebfingerXrd } from '../modules/federation/public.js';
import type { IncomingMessage } from 'node:http';
import type { LocalWebfingerFacts, LocalWebfingerQuery } from '../modules/federation/public.js';
const path = '/.well-known/webfinger';
const jrd = 'application/jrd+json';
const xrd = 'application/xrd+xml';

export function createWebfingerApi(parts: {
	selfUrl: string;
	federationEnabled(): Promise<boolean>;
	readUser(query: LocalWebfingerQuery): Promise<LocalWebfingerFacts | null>;
}): Hono {
	return new Hono().use(path, async (c, next) => {
		c.header('Access-Control-Allow-Headers', 'Accept');
		c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Access-Control-Expose-Headers', 'Vary');
		await next();
	}).options(path, c => c.body(null, 204)).get(path, async c => {
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			const resources = c.req.queries('resource');
			if (!resources || resources.length !== 1) {
				return c.body(null, 400);
			}
			const query = localWebfingerQuery(resources[0], parts.selfUrl);
			if (query === null) {
				return c.body(null, 422);
			}
			const user = await parts.readUser(query);
			if (user === null) {
				return c.body(null, 404);
			}
			const document = renderLocalWebfinger(user, parts.selfUrl);
			const negotiation = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
			c.header('Vary', 'Accept');
			c.header('Cache-Control', 'public, max-age=180');
			if (negotiation.type([jrd, xrd]) === xrd) {
				c.header('Content-Type', xrd);
				return c.body(renderWebfingerXrd(document));
			}
			c.header('Content-Type', `${jrd}; charset=utf-8`);
			return c.body(JSON.stringify(document));
		} catch {
			return c.body(null, 500);
		}
	});
}
