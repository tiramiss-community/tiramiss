/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { parse } from 'node-html-parser';
import { createSignedGet } from './http-signature.js';
import { extractDbHost, punyHost } from './host.js';
import type { OutboundHttp } from '../../application/outbound-http.js';
import type { HttpSignatureKey } from './http-signature.js';

export const activityAccept = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
export interface ActivitySession {
	resolve(value: string | Record<string, unknown>): Promise<Record<string, unknown>>;
}
export class ActivityFetchError extends Error {
	constructor(readonly id: string, message: string) {
		super(message);
	}
}
export function assertActivityIdentity(request: string, object: Record<string, unknown>, final: string): void {
	if (!object.id) {
		throw new Error('bad Activity: missing id field');
	}
	const normalized = (value: string) => {
		const url = new URL(value);
		url.hostname = url.hostname.replace(/^www\./, '');
		return url;
	};
	const req = normalized(request), id = normalized(object.id as string), end = normalized(final);
	req.hash = '';
	end.hash = '';
	if (req.protocol === 'https:' && end.protocol !== 'https:') {
		throw new Error(`bad Activity: id(${object.id}) is not allowed to have http:// in the url`);
	}
	if (end.href !== id.href) {
		throw new Error(`bad Activity: id(${object.id}) does not match response url(${end})`);
	}
	if (req.href !== id.href) {
		throw new Error(`bad Activity: id(${object.id}) does not match request url(${req})`);
	}
}

function validateContentType(contentType: string | null): void {
	const type = (contentType ?? '').toLowerCase();
	if (!type) {
		throw new Error('Validate content type of AP response: No content-type header');
	}
	if (type.startsWith('application/activity+json') || (type.startsWith('application/ld+json;') && type.includes('https://www.w3.org/ns/activitystreams'))) {
		return;
	}
	throw new Error('Validate content type of AP response: Content type is not application/activity+json or application/ld+json');
}

export function createActivitySession(parts: {
	http: Pick<OutboundHttp, 'send'>;
	signed: boolean;
	clock(): number;
	isSelfHost(host: string): boolean;
	isAllowedHost(host: string): Promise<boolean>;
	signer(): Promise<HttpSignatureKey>;
	resolveLocal(uri: string): Promise<Record<string, unknown>>;
}): ActivitySession {
	const history = new Set<string>();
	let signer: Promise<HttpSignatureKey> | undefined;

	async function fetchActivity(url: string, followAlternate: boolean): Promise<Record<string, unknown>> {
		let headers: Record<string, string> = { Accept: activityAccept };
		if (parts.signed) {
			signer ??= parts.signer();
			headers = (await createSignedGet({ key: await signer, url, additionalHeaders: {} }, new Date(parts.clock()))).request.headers;
		}
		const response = await parts.http.send(url, { method: 'GET', headers, timeoutMs: 5000, maxBytes: parts.signed ? 10485760 : 262144 });
		if (parts.signed && followAlternate && (response.header('content-type') ?? '').split(';')[0].trimEnd().toLowerCase() === 'text/html') {
			const html = await response.text();
			try {
				const href = parse(html).querySelector('head > link[rel="alternate"][type="application/activity+json"]')?.getAttribute('href');
				if (href && punyHost(url) === punyHost(href)) {
					return await fetchActivity(href, false);
				}
			} catch { /* Source swallows parsing and alternate-fetch failures, then validates the original HTML. */ }
		}
		validateContentType(response.header('content-type'));
		const activity = await response.json() as Record<string, unknown>;
		assertActivityIdentity(url, activity, response.finalUrl);
		return activity;
	}

	return {
		async resolve(value) {
			if (typeof value !== 'string') {
				return value;
			}
			if (value.includes('#')) {
				throw new ActivityFetchError('b94fd5b1-0e3b-4678-9df2-dad4cd515ab2', `cannot resolve URL with fragment: ${value}`);
			}
			if (history.has(value)) {
				throw new ActivityFetchError('0dc86cf6-7cd6-4e56-b1e6-5903d62d7ea5', 'cannot resolve already resolved one');
			}
			if (history.size > 256) {
				throw new ActivityFetchError('d592da9f-822f-4d91-83d7-4ceefabcf3d2', `hit recursion limit: ${extractDbHost(value)}`);
			}
			history.add(value);
			const host = extractDbHost(value);
			if (parts.isSelfHost(host)) {
				return parts.resolveLocal(value);
			}
			if (!await parts.isAllowedHost(host)) {
				throw new ActivityFetchError('09d79f9e-64f1-4316-9cfa-e75c4d091574', 'Instance is blocked');
			}
			const object = await fetchActivity(value, true);
			const context = object['@context'];
			if (Array.isArray(context) ? !context.includes('https://www.w3.org/ns/activitystreams') : context !== 'https://www.w3.org/ns/activitystreams') {
				throw new ActivityFetchError('72180409-793c-4973-868e-5a118eb5519b', 'invalid response');
			}
			return object;
		}
	};
}
