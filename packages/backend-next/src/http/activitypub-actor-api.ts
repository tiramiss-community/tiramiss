/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { renderLocalActor } from '../modules/federation/public.js';
import type { LocalActorFacts } from '../modules/federation/public.js';
const ap = 'application/activity+json';
const ld = 'application/ld+json';
export function createActivityPubActorApi(parts: {
	readActor(id: string): Promise<(LocalActorFacts & {
		host: string | null;
		uri: string | null;
	}) | null>;
	federationEnabled(): Promise<boolean>;
	isSelfHost(host: string): boolean;
	publicKey(id: string): Promise<string>;
	selfUrl: string;
}) {
	return new Hono().get('/users/:id', async c => {
		const negotiation = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
		const chosen = negotiation.type(['html', ap, ld]);
		if (!chosen || chosen === 'html') {
			return c.notFound();
		}
		c.header('Vary', 'Accept');
		if (!await parts.federationEnabled()) {
			return c.body(null, 403);
		}
		const user = await parts.readActor(c.req.param('id'));
		if (!user) {
			return c.body(null, 404);
		}
		if (user.host !== null) {
			if (!user.uri || parts.isSelfHost(user.host)) {
				return c.body(null, 500);
			}
			return c.redirect(user.uri, 301);
		}
		const body = JSON.stringify(renderLocalActor(user, parts.selfUrl, await parts.publicKey(user.id)));

		c.header('Cache-Control', 'public, max-age=180');
		c.header('Content-Type', `${negotiation.type([ap, ld]) === ld ? ld + '; profile="https://www.w3.org/ns/activitystreams"' : ap}; charset=utf-8`);
		return c.body(body);
	});
}
