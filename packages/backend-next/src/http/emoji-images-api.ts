/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { STATUS_CODES } from 'node:http';
import { Readable } from 'node:stream';
import { Hono } from 'hono';

export interface EmojiImageAssets {
	file(kind: 'fluent' | 'twemoji', name: string, request: { method: string; headers: Record<string, string> }): Promise<{
		status: number;
		headers: Record<string, string>;
		body?: Readable;
		error?: { message: string; code?: string; headers?: Record<string, string> };
	}>;
	badge(name: string): Promise<Buffer>;
}

const csp = "default-src 'none'; style-src 'unsafe-inline'";

function json(body: object, status: number, headers: Record<string, string> = {}) {
	const text = JSON.stringify(body);
	return new Response(text, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), ...headers } });
}

function notFound(method: string, url: string, headers?: Record<string, string>) {
	return json({ message: `Route ${method}:${url} not found`, error: 'Not Found', statusCode: 404 }, 404, headers);
}

export function createEmojiImagesApi(assets: EmojiImageAssets) {
	const app = new Hono();
	for (const [prefix, kind, pattern] of [
		['/fluent-emoji/', 'fluent', /^[0-9a-f-]+\.png$/],
		['/twemoji/', 'twemoji', /^[0-9a-f-]+\.svg$/],
		['/twemoji-badge/', 'badge', /^[0-9a-f-]+\.png$/],
	] as const) {
		app.get(`${prefix}*`, async c => {
			const url = new URL(c.req.url);
			let decodedPath: string;
			try {
				decodedPath = decodeURIComponent(url.pathname);
			} catch {
				return json({ error: 'Bad Request', code: 'FST_ERR_BAD_URL', message: `'${url.pathname}' is not a valid url component`, statusCode: 400 }, 400, { 'Content-Type': 'application/json' });
			}
			const boundary = url.pathname.indexOf('/', 1);
			if (boundary === -1 || url.pathname.slice(boundary + 1).includes('/')) {
				return notFound(c.req.method, url.pathname + url.search);
			}
			// Static route segments may be encoded too; retain the raw separator
			// boundary while taking the filename from the once-decoded path.
			const decodedPrefix = decodeURIComponent(url.pathname.slice(0, boundary + 1));
			const name = decodedPath.slice(decodedPrefix.length);
			if (!pattern.test(name)) {
				return new Response(null, { status: 404, headers: { 'Content-Length': '0' } });
			}

			if (kind === 'badge') {
				try {
					const buffer = await assets.badge(name);
					return new Response(new Uint8Array(buffer), { headers: { 'Content-Type': 'image/png', 'Content-Length': String(buffer.length), 'Content-Security-Policy': csp, 'Cache-Control': 'max-age=2592000' } });
				} catch (error) {
					if (!(error instanceof Error)) {
						throw error;
					}
					return json({ statusCode: 500, error: 'Internal Server Error', message: error.message }, 500);
				}
			}

			const file = await assets.file(kind, name, { method: c.req.method, headers: Object.fromEntries(c.req.raw.headers) });
			const headers = { 'Content-Security-Policy': csp };
			if (file.status === 404) {
				return notFound(c.req.method, url.pathname + url.search, headers);
			}
			if (file.error) {
				return json({ statusCode: file.status, ...(file.error.code ? { code: file.error.code } : {}), error: STATUS_CODES[file.status], message: file.error.message }, file.status, { ...headers, ...file.error.headers });
			}
			const body = file.body ? Readable.toWeb(file.body) as ReadableStream<Uint8Array> : null;
			return new Response(body, { status: file.status, headers: { ...headers, ...file.headers } });
		});
	}
	return app;
}
