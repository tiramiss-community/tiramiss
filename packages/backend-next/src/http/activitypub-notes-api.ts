/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import { Hono } from 'hono';
import { apContext } from '../modules/federation/public.js';
import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import type { NotePublicationRow } from '../modules/federation/public.js';
import type { Logger } from '../platform/logger.js';
const activity = 'application/activity+json; charset=utf-8';
const ld = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';

function negotiation(c: Context) {
	return accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
}

function cors(c: Context) {
	c.header('Access-Control-Allow-Headers', 'Accept');
	c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
	c.header('Access-Control-Allow-Origin', '*');
	c.header('Access-Control-Expose-Headers', 'Vary');
}

function responseType(c: Context) {
	c.header('Content-Type', negotiation(c).type([activity, ld]) === ld ? ld : activity);
}

function failed(c: Context, logger: Pick<Logger, 'error'>, route: string) {
	logger.error('activitypub-publication.failed', { classification: 'unexpected-failure', route });
	c.header('Content-Type', 'application/json; charset=utf-8');
	return c.body(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' }), 500);
}

export function createActivityPubNotesApi(parts: {
	selfUrl: string;
	production: boolean;
	allowExternalApRedirect(): Promise<boolean>;
	logger: Pick<Logger, 'error'>;
	federationEnabled(): Promise<boolean>;
	isSelfHost(host: string): boolean;
	readFeatured(id: string): Promise<Record<string, unknown> | null>;
	readPublicNote(id: string): Promise<NotePublicationRow | null>;
	renderNote(note: NotePublicationRow): Promise<Record<string, unknown>>;
}): Hono {
	return new Hono().get('/users/:id/collections/featured', async (c) => {
		cors(c);
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			const collection = await parts.readFeatured(c.req.param('id'));
			if (collection === null) {
				return c.body(null, 404);
			}
			c.header('Cache-Control', 'public, max-age=180');
			responseType(c);
			return c.body(JSON.stringify(collection));
		} catch {
			return failed(c, parts.logger, 'featured');
		}
	}).get('/notes/:id', async (c) => {
		const chosen = negotiation(c).type(['html', activity, ld]);
		// The pinned ClientServerService owns HTML. Its frontend route remains unimplemented here (#196).
		if (!chosen || chosen === 'html') {
			return c.notFound();
		}
		cors(c);
		c.header('Vary', 'Accept');
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			const note = await parts.readPublicNote(c.req.param('id'));
			if (note === null) {
				return c.body(null, 404);
			}
			if (note.userHost !== null) {
				if (note.uri === null || parts.isSelfHost(note.userHost)) {
					return c.body(null, 500);
				}
				const redirected = c.redirect(note.uri, 302);
				const location = redirected.headers.get('location')!;
				const effectiveLocation = parts.production ? location : location.replace(/^http:\/\//, 'https://');
				if (!await parts.allowExternalApRedirect()
					&& /application\/activity\+json|application\/ld\+json.+activitystreams/i.test(c.req.header('accept') ?? '')
					&& !effectiveLocation.startsWith(`https://${new URL(parts.selfUrl).host}/`)) {
					c.header('Location', undefined);
					c.header('Content-Type', 'text/plain; charset=utf-8');
					c.header('Link', `<${encodeURI(location)}>; rel="canonical"`);
					return c.body([
						'Refusing to relay remote ActivityPub object lookup.',
						'',
						`Please remove 'application/activity+json' and 'application/ld+json' from the Accept header or fetch using the authoritative URL at ${location}.`,
					].join('\n'), 406);
				}
				return redirected;
			}
			c.header('Cache-Control', 'public, max-age=180');
			responseType(c);
			return c.body(JSON.stringify({ '@context': apContext, ...await parts.renderNote(note) }));
		} catch {
			return failed(c, parts.logger, 'note');
		}
	});
}
