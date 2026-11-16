/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { getPath } from 'hono/utils/url';
import { avatarImageUrl, emojiImageUrl, parseAvatarAcct } from '../modules/avatar-images/public.js';
import type { AvatarImageReader, AvatarImageSettings } from '../modules/avatar-images/public.js';

const cache = 'public, max-age=86400';
const csp = 'default-src \'none\'; style-src \'unsafe-inline\'';

function json(body: object, status: number, headers: Record<string, string> = {}) {
	const text = JSON.stringify(body);
	return new Response(text, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...headers } });
}

function imageRequestTarget(request: Request, bindings?: unknown): string {
	const incoming = bindings && typeof bindings === 'object' && 'incoming' in bindings ? bindings.incoming : undefined;
	const target = incoming && typeof incoming === 'object' && 'url' in incoming && typeof incoming.url === 'string' ? incoming.url : undefined;
	if (target?.startsWith('/')) {
		return target;
	}
	const url = request.url;
	const start = url.indexOf('/', url.indexOf(':') + 3);
	return start === -1 ? '/' : url.slice(start);
}

// Only image route dispatch uses the adapter's original request target. Other
// routes retain Hono's existing pathname semantics.
export const getAvatarImagesPath: Hono['getPath'] = (request, options) => {
	const target = imageRequestTarget(request, options?.env);
	const pathname = target.split('?', 1)[0];
	const boundary = pathname.indexOf('/', 1);
	let prefix: string;
	try {
		prefix = decodeURIComponent(pathname.slice(1, boundary === -1 ? undefined : boundary));
	} catch {
		return getPath(request);
	}
	if (!['emoji', 'avatar', 'identicon'].includes(prefix)) {
		return getPath(request);
	}
	return `/${prefix}${boundary === -1 ? '' : pathname.slice(boundary)}`;
};

export function createAvatarImagesApi(options: {
	reader: AvatarImageReader;
	readSettings(): Promise<AvatarImageSettings>;
	generate(seed: string): Promise<Buffer>;
	url: string;
	mediaProxy: string;
}) {
	const app = new Hono({ getPath: getAvatarImagesPath });
	for (const kind of ['emoji', 'avatar', 'identicon'] as const) {
		app.get(`/${kind}/*`, async c => {
			const target = imageRequestTarget(c.req.raw, c.env);
			const queryStart = target.indexOf('?');
			const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
			const search = queryStart === -1 ? '' : target.slice(queryStart);
			const query = new URLSearchParams(search);
			const headers: Record<string, string> = {};
			let decoded: string;
			try {
				decoded = decodeURIComponent(pathname);
			} catch {
				return json({ error: 'Bad Request', code: 'FST_ERR_BAD_URL', message: `'${pathname}' is not a valid url component`, statusCode: 400 }, 400, { 'Content-Type': 'application/json' });
			}
			const boundary = pathname.indexOf('/', 1);
			const raw = pathname.slice(boundary + 1);
			if (boundary === -1 || (boundary !== -1 && raw.includes('/')) || (kind === 'avatar' && !raw.startsWith('@'))) {
				return json({ message: `Route ${c.req.method}:${pathname}${search} not found`, error: 'Not Found', statusCode: 404 }, 404);
			}
			const value = boundary === -1 ? '' : decoded.slice(decodeURIComponent(pathname.slice(0, boundary + 1)).length);
			if (value.length - (kind === 'avatar' ? 1 : 0) > 100) {
				return json({ error: 'Bad Request', code: 'FST_ERR_MAX_PARAM_LENGTH', message: `'${decoded}' is exceeding the max param length`, statusCode: 414 }, 414, { 'Content-Type': 'application/json' });
			}
			const empty = (status: number, location?: string) => new Response(null, { status, headers: { ...headers, ...(location !== undefined ? { Location: location } : {}), 'Content-Length': '0' } });
			try {
				if (kind === 'emoji') {
					headers['Cache-Control'] = cache;
					if (!/^[a-zA-Z0-9\-_@\.]+?\.webp$/.test(value)) {
						return empty(404);
					}
					const chunks = value.slice(0, -5).split('@');
					if (chunks.length > 2) {
						return empty(400);
					}
					const name = chunks.shift()!;
					const host = chunks.pop();
					const emoji = await options.reader.emoji(name, host === undefined || host === '.' ? null : host);
					headers['Content-Security-Policy'] = csp;
					if (emoji == null) {
						return query.has('fallback') ? empty(302, '/static-assets/emoji-unknown.png') : empty(404);
					}
					return empty(301, emojiImageUrl(emoji, options.mediaProxy, { badge: query.has('badge'), static: query.has('static') }));
				}
				if (kind === 'avatar') {
					const acct = parseAvatarAcct(value.slice(1), new URL(options.url).host);
					const user = await options.reader.user(acct.usernameLower, acct.host);
					headers['Cache-Control'] = cache;
					if (!user) {
						return empty(302, '/static-assets/user-unknown.png');
					}
					const needsIcon = (user.avatarId == null || user.avatarUrl == null) && (user.host == null || user.host === new URL(options.url).host) && user.username.includes('.');
					return empty(302, avatarImageUrl(user, options.url, needsIcon ? (await options.readSettings()).iconUrl : null));
				}
				headers['Content-Type'] = 'image/png';
				headers['Cache-Control'] = cache;
				if (!(await options.readSettings()).enableIdenticonGeneration) {
					return empty(302, '/static-assets/avatar.png');
				}
				const buffer = await options.generate(value);
				return new Response(new Uint8Array(buffer), { headers: { ...headers, 'Content-Length': String(buffer.length) } });
			} catch (error) {
				if (!(error instanceof Error)) {
					throw error;
				}
				const code = 'code' in error ? error.code : undefined;
				delete headers['Content-Type'];
				return json({ statusCode: 500, ...(typeof code === 'string' ? { code } : {}), error: 'Internal Server Error', message: error.message }, 500, headers);
			}
		});
	}
	return app;
}
