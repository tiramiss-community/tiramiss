/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { avatarImageUrl, emojiImageUrl, parseAvatarAcct } from '../modules/avatar-images/public.js';
import type { AvatarImageReader, AvatarImageSettings } from '../modules/avatar-images/public.js';

const cache = 'public, max-age=86400';
const csp = 'default-src \'none\'; style-src \'unsafe-inline\'';

function json(body: object, status: number, headers: Record<string, string> = {}) {
	const text = JSON.stringify(body);
	return new Response(text, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...headers } });
}

export function createAvatarImagesApi(options: {
	reader: AvatarImageReader;
	readSettings(): Promise<AvatarImageSettings>;
	generate(seed: string): Promise<Buffer>;
	url: string;
	mediaProxy: string;
}) {
	const app = new Hono();
	for (const kind of ['emoji', 'avatar', 'identicon'] as const) {
		app.get(`/${kind}/*`, async c => {
			const url = new URL(c.req.url);
			const headers: Record<string, string> = {};
			let decoded: string;
			try {
				decoded = decodeURIComponent(url.pathname);
			} catch {
				return json({ error: 'Bad Request', code: 'FST_ERR_BAD_URL', message: `'${url.pathname}' is not a valid url component`, statusCode: 400 }, 400, { 'Content-Type': 'application/json' });
			}
			const boundary = url.pathname.indexOf('/', 1);
			const raw = url.pathname.slice(boundary + 1);
			if ((boundary === -1 && kind !== 'emoji') || (boundary !== -1 && raw.includes('/')) || (kind === 'avatar' && !raw.startsWith('@'))) {
				return json({ message: `Route ${c.req.method}:${url.pathname}${url.search} not found`, error: 'Not Found', statusCode: 404 }, 404);
			}
			const value = boundary === -1 ? '' : decoded.slice(decodeURIComponent(url.pathname.slice(0, boundary + 1)).length);
			if (value.length - (kind === 'avatar' ? 1 : 0) > 100) {
				return json({ error: 'Bad Request', code: 'FST_ERR_MAX_PARAM_LENGTH', message: `'${url.pathname}' is exceeding the max param length`, statusCode: 414 }, 414, { 'Content-Type': 'application/json' });
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
						return url.searchParams.has('fallback') ? empty(302, '/static-assets/emoji-unknown.png') : empty(404);
					}
					return empty(301, emojiImageUrl(emoji, options.mediaProxy, { badge: url.searchParams.has('badge'), static: url.searchParams.has('static') }));
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
