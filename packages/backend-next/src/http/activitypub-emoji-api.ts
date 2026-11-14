/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import { Hono } from 'hono';
import { apContext } from '../modules/federation/public.js';
import type { Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { ApEmojiFacts } from '../modules/federation/public.js';
import type { Logger } from '../platform/logger.js';

const activity = 'application/activity+json; charset=utf-8';
const ld = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';

function routerError(c: Context, status: 400 | 414) {
	return c.body(JSON.stringify({ statusCode: status, error: 'Bad Request', message: 'Bad Request' }), status, { 'Content-Type': 'application/json' });
}

export function createActivityPubEmojiApi(parts: {
	federationEnabled(): Promise<boolean>;
	readEmoji(name: string): Promise<ApEmojiFacts | null>;
	renderEmoji(emoji: ApEmojiFacts): Record<string, unknown>;
	logger: Pick<Logger, 'error'>;
}): Hono {
	const app = new Hono();
	const handler = async (c: Context) => {
		let name: string;
		try {
			name = decodeURIComponent(new URL(c.req.url).pathname.split('/')[2]);
		} catch {
			return routerError(c, 400);
		}
		if (name.length > 100) {
			return routerError(c, 414);
		}
		c.header('Access-Control-Allow-Headers', 'Accept');
		c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Access-Control-Expose-Headers', 'Vary');
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			const emoji = await parts.readEmoji(name);
			if (emoji === null || emoji.localOnly) {
				return c.body(null, 404);
			}
			c.header('Cache-Control', 'public, max-age=180');
			const negotiation = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
			c.header('Content-Type', negotiation.type([activity, ld]) === ld ? ld : activity);
			return c.body(JSON.stringify({ '@context': apContext, ...parts.renderEmoji(emoji) }));
		} catch {
			parts.logger.error('activitypub-emoji.failed', { classification: 'unexpected-failure' });
			c.header('Content-Type', 'application/json; charset=utf-8');
			return c.body(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' }), 500);
		}
	};
	for (const path of ['/emojis/:emoji', '/emojis/']) {
		app.get(path, handler);
		app.options(path, c => {
			try {
				decodeURIComponent(new URL(c.req.url).pathname.split('/')[2]);
			} catch {
				return routerError(c, 400);
			}
			return c.body(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Not Found' }), 404, { 'Content-Type': 'application/json; charset=utf-8' });
		});
	}
	return app;
}
