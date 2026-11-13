/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { FollowCollectionDirection, FollowCollectionResult } from '../modules/federation/public.js';
import type { Logger } from '../platform/logger.js';

const activity = 'application/activity+json; charset=utf-8';
const ld = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';

function decodeQueryComponent(raw: string): string {
	const value = raw.replace(/\+/g, ' ');
	try {
		return decodeURIComponent(value);
	} catch {
		// Pinned fast-querystring 1.1.2 keeps the entire component on invalid escapes/UTF-8.
		return value;
	}
}

function followCollectionQuery(url: string): { cursor?: string[]; page?: string[] } {
	const query: { cursor?: string[]; page?: string[] } = {};
	const start = url.indexOf('?');
	if (start === -1) {
		return query;
	}
	for (const pair of url.slice(start + 1).split('&')) {
		const equals = pair.indexOf('=');
		const key = decodeQueryComponent(equals === -1 ? pair : pair.slice(0, equals));
		if (key === 'cursor' || key === 'page') {
			(query[key] ??= []).push(decodeQueryComponent(equals === -1 ? '' : pair.slice(equals + 1)));
		}
	}
	return query;
}

export function createActivityPubFollowCollectionsApi(parts: {
	federationEnabled(): Promise<boolean>;
	readCollection(id: string, direction: FollowCollectionDirection, page: boolean, cursor?: string): Promise<FollowCollectionResult>;
	logger: Pick<Logger, 'error'>;
}): Hono {
	const app = new Hono();
	for (const direction of ['followers', 'following'] as const) {
		const path = `/users/:id/${direction}`;
		app.get(path, async c => {
			c.header('Access-Control-Allow-Headers', 'Accept');
			c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Expose-Headers', 'Vary');
			try {
				if (!await parts.federationEnabled()) {
					return c.body(null, 403);
				}
				const { cursor: cursors, page: pages } = followCollectionQuery(c.req.url);
				if (cursors && cursors.length !== 1) {
					return c.body(null, 400);
				}
				const result = await parts.readCollection(c.req.param('id')!, direction, pages?.length === 1 && pages[0] === 'true', cursors?.[0]);
				if (result.cacheSeconds !== undefined) {
					c.header('Cache-Control', `public, max-age=${result.cacheSeconds}`);
				}
				if (result.status !== 200) {
					return c.body(null, result.status);
				}
				const negotiation = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
				c.header('Content-Type', negotiation.type([activity, ld]) === ld ? ld : activity);
				return c.body(JSON.stringify(result.collection));
			} catch {
				parts.logger.error('activitypub-publication.failed', { classification: 'unexpected-failure', route: direction });
				c.header('Content-Type', 'application/json; charset=utf-8');
				return c.body(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' }), 500);
			}
		});
		// The pinned plugin registers GET (including HEAD), with no OPTIONS handler or CORS hook on its fallback.
		app.options(path, c => c.body(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Not Found' }), 404, { 'Content-Type': 'application/json; charset=utf-8' }));
	}
	return app;
}
