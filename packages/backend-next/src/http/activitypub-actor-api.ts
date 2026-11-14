/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import accepts from 'accepts';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { apContext } from '../modules/federation/ap-context.js';
import { renderLocalActor, renderLocalKey, actorLookupAcct } from '../modules/federation/public.js';
import type { Acct, LocalActorFacts, LocalActorMaterials, LocalActorTag } from '../modules/federation/public.js';
type Actor = LocalActorFacts & { host: string | null; uri: string | null };
const ap = 'application/activity+json';
const ld = 'application/ld+json';
const activityType = `${ap}; charset=utf-8`;
const ldType = `${ld}; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8`;
interface ActorParts {
	readActor(id: string): Promise<(LocalActorFacts & {
		host: string | null;
		uri: string | null;
	}) | null>;
	readTags(user: LocalActorFacts): Promise<LocalActorTag[]>;
	readMaterials(user: LocalActorFacts): Promise<LocalActorMaterials>;
	federationEnabled(): Promise<boolean>;
	isSelfHost(host: string): boolean;
	publicKey(id: string): Promise<string>;
	selfUrl: string;
}
export function createActivityPubActorApi(parts: ActorParts) {
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
		const { profile, media } = await parts.readMaterials(user);
		const tag = await parts.readTags(user);
		const body = JSON.stringify(renderLocalActor(user, profile, parts.selfUrl, await parts.publicKey(user.id), tag, media));

		c.header('Cache-Control', 'public, max-age=180');
		c.header('Content-Type', `${negotiation.type([ap, ld]) === ld ? ld + '; profile="https://www.w3.org/ns/activitystreams"' : ap}; charset=utf-8`);
		return c.body(body);
	});
}

export function createActivityPubActorAliasKeyApi(parts: ActorParts & {
	readActorByAcct(acct: Acct): Promise<Actor | null>;
	readKeyOwner(id: string): Promise<{ id: string } | null>;
	allowExternalApRedirect(): Promise<boolean>;
	production: boolean;
	readPublicKey(id: string): Promise<string>;
	toSpki(publicKey: string): string;
}) {
	const app = createActivityPubActorApi(parts);

	function cors(c: Context) {
		c.header('Access-Control-Allow-Headers', 'Accept');
		c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
		c.header('Access-Control-Allow-Origin', '*');
		c.header('Access-Control-Expose-Headers', 'Vary');
	}

	function responseType(c: Context) {
		const negotiation = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage);
		c.header('Content-Type', negotiation.type([activityType, ldType]) === ldType ? ldType : activityType);
	}

	function failure(c: Context, status: 400 | 500) {
		c.header('Content-Type', status === 400 ? 'application/json' : 'application/json; charset=utf-8');
		return c.body(JSON.stringify({ statusCode: status, error: status === 400 ? 'Bad Request' : 'Internal Server Error', message: status === 400 ? 'Bad Request' : 'Internal Server Error' }), status);
	}

	app.get('/:acct{@[^/]+}', async c => {
		let value: string;
		try {
			// Decode the raw route component once, before AP hooks, as the pinned router does.
			value = decodeURIComponent(new URL(c.req.url).pathname.slice(2));
		} catch {
			return failure(c, 400);
		}
		const chosen = accepts({ headers: { accept: c.req.header('accept') } } as IncomingMessage).type(['html', activityType, ldType]);
		if (!chosen || chosen === 'html') {
			return c.notFound();
		}
		cors(c);
		c.header('Vary', 'Accept');
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			const acct = actorLookupAcct(value, parts.isSelfHost);
			const user = await parts.readActorByAcct(acct);
			if (!user) {
				return c.body(null, 404);
			}
			if (user.host !== null) {
				if (user.uri === null || parts.isSelfHost(user.host)) {
					return c.body(null, 500);
				}
				const location = user.uri;
				const effectiveLocation = parts.production ? location : location.replace(/^http:\/\//, 'https://');
				if (!await parts.allowExternalApRedirect()
					&& /application\/activity\+json|application\/ld\+json.+activitystreams/i.test(c.req.header('accept') ?? '')
					&& !effectiveLocation.startsWith(`https://${new URL(parts.selfUrl).host}/`)) {
					c.header('Content-Type', 'text/plain; charset=utf-8');
					c.header('Link', `<${encodeURI(location)}>; rel="canonical"`);
					return c.body([
						'Refusing to relay remote ActivityPub object lookup.', '',
						`Please remove 'application/activity+json' and 'application/ld+json' from the Accept header or fetch using the authoritative URL at ${location}.`,
					].join('\n'), 406);
				}
				return c.redirect(location, 301);
			}
			// Source sets success metadata before actor rendering, including rendering errors.
			c.header('Cache-Control', 'public, max-age=180');
			responseType(c);
			const { profile, media } = await parts.readMaterials(user);
			const tags = await parts.readTags(user);
			return c.body(JSON.stringify(renderLocalActor(user, profile, parts.selfUrl, await parts.publicKey(user.id), tags, media)));
		} catch {
			return failure(c, 500);
		}
	});
	app.get('/users/:user/publickey', async c => {
		let id: string;
		try {
			id = decodeURIComponent(new URL(c.req.url).pathname.split('/')[2]);
		} catch {
			return failure(c, 400);
		}
		cors(c);
		try {
			if (!await parts.federationEnabled()) {
				return c.body(null, 403);
			}
			const owner = await parts.readKeyOwner(id);
			if (!owner) {
				return c.body(null, 404);
			}
			const key = await parts.readPublicKey(owner.id);
			c.header('Cache-Control', 'public, max-age=180');
			responseType(c);
			return c.body(JSON.stringify({ '@context': apContext, ...renderLocalKey(owner.id, parts.selfUrl, parts.toSpki(key)) }));
		} catch {
			return failure(c, 500);
		}
	});
	return app;
}
