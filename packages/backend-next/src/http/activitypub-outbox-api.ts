/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import { Hono } from 'hono';
import { apContext } from '../modules/federation/public.js';
import type { Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { NotePublicationRow, OutboxBounds } from '../modules/federation/public.js';
import type { Logger } from '../platform/logger.js';

const activity = 'application/activity+json; charset=utf-8';
const ld = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';

function query(url: string): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	const decode = (raw: string) => {
		const value = raw.replace(/\+/g, ' ');
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};
	const start = url.indexOf('?');
	if (start === -1) {
		return result;
	}
	for (const pair of url.slice(start + 1).split('&')) {
		const equals = pair.indexOf('=');
		const key = decode(equals === -1 ? pair : pair.slice(0, equals));
		if (key !== 'page' && key !== 'since_id' && key !== 'until_id') {
			continue;
		}
		(result[key] ??= []).push(decode(equals === -1 ? '' : pair.slice(equals + 1)));
	}
	return result;
}

function routerError(c: Context, status: 400 | 414) {
	return c.body(JSON.stringify({ statusCode: status, error: 'Bad Request', message: 'Bad Request' }), status, { 'Content-Type': 'application/json' });
}

function responseType(c: Context) {
	const negotiation = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
	c.header('Content-Type', negotiation.type([activity, ld]) === ld ? ld : activity);
}

export function createActivityPubOutboxApi(parts: {
	federationEnabled(): Promise<boolean>;
	readOutbox(id: string, page: boolean, bounds: OutboxBounds): Promise<Record<string, unknown> | null>;
	readLocalActivityNote(id: string): Promise<NotePublicationRow | null>;
	renderActivity(note: NotePublicationRow): Promise<Record<string, unknown>>;
	logger: Pick<Logger, 'error'>;
}): Hono {
	const app = new Hono();
	for (const route of ['outbox', 'activity'] as const) {
		const path = route === 'outbox' ? '/users/:user/outbox' : '/notes/:note/activity';
		const handler = async (c: Context) => {
			let id: string;
			try {
				id = decodeURIComponent(new URL(c.req.url).pathname.split('/')[2]);
			} catch {
				return routerError(c, 400);
			}
			if (id.length > 100) {
				return routerError(c, 414);
			}
			c.header('Access-Control-Allow-Headers', 'Accept');
			c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Expose-Headers', 'Vary');
			if (route === 'activity') {
				c.header('Vary', 'Accept');
			}
			try {
				if (!await parts.federationEnabled()) {
					return c.body(null, 403);
				}
				if (route === 'activity') {
					const note = await parts.readLocalActivityNote(id);
					if (note === null) {
						return c.body(null, 404);
					}
					c.header('Cache-Control', 'public, max-age=180');
					responseType(c);
					return c.body(JSON.stringify({ '@context': apContext, ...await parts.renderActivity(note) }));
				}
				const params = query(c.req.url);
				if (params.since_id && params.since_id.length !== 1 || params.until_id && params.until_id.length !== 1 || params.since_id && params.until_id) {
					return c.body(null, 400);
				}
				const page = params.page?.length === 1 && params.page[0] === 'true';
				const result = await parts.readOutbox(id, page, { sinceId: params.since_id?.[0] ?? null, untilId: params.until_id?.[0] ?? null });
				if (result === null) {
					return c.body(null, 404);
				}
				if (!page) {
					c.header('Cache-Control', 'public, max-age=180');
				}
				responseType(c);
				return c.body(JSON.stringify(result));
			} catch {
				parts.logger.error('activitypub-publication.failed', { classification: 'unexpected-failure', route });
				c.header('Content-Type', 'application/json; charset=utf-8');
				return c.body(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' }), 500);
			}
		};
		app.get(path, handler);
		// Hono's regexp router cannot capture an empty parameter; the source accepts it.
		const emptyPath = route === 'outbox' ? '/users//outbox' : '/notes//activity';
		app.get(emptyPath, handler);
		const options = (c: Context) => {
			try {
				decodeURIComponent(new URL(c.req.url).pathname.split('/')[2]);
			} catch {
				return routerError(c, 400);
			}
			return c.body(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Not Found' }), 404, { 'Content-Type': 'application/json; charset=utf-8' });
		};
		app.options(emptyPath, options);
		app.options(path, options);
	}
	return app;
}
