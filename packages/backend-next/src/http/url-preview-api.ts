/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { PreviewDisabled, PreviewFailed } from '../modules/url-preview/public.js';
import type { PreviewSummary } from '../modules/url-preview/public.js';

function decodeQueryComponent(raw: string): string {
	const value = raw.replace(/\+/g, ' ');
	try {
		return decodeURIComponent(value);
	} catch {
		// Pinned fast-querystring retains the entire component on invalid escapes or UTF-8.
		return value;
	}
}

function previewQuery(url: string): { url?: string[]; lang?: string[] } {
	const result: { url?: string[]; lang?: string[] } = {};
	const start = url.indexOf('?');
	if (start === -1) {
return result;
}
	for (const pair of url.slice(start + 1).split('&')) {
		const equals = pair.indexOf('=');
		const key = decodeQueryComponent(equals === -1 ? pair : pair.slice(0, equals));
		if (key === 'url' || key === 'lang') {
			(result[key] ??= []).push(decodeQueryComponent(equals === -1 ? '' : pair.slice(equals + 1)));
		}
	}
	return result;
}

export function createUrlPreviewApi(application: { preview(url: string, lang?: string): Promise<PreviewSummary> }) {
	return new Hono().get('/url', async c => {
		const { url: urls, lang: langs } = previewQuery(c.req.url);
		if (urls?.length !== 1 || (langs && langs.length !== 1)) {
			return c.body(null, 400);
		}
		try {
			const result = await application.preview(urls[0], langs?.[0]);
			c.header('Cache-Control', 'max-age=86400, immutable');
			return c.json(result);
		} catch (error) {
			if (error instanceof PreviewDisabled) {
				return c.json({ error: {
					message: 'URL preview is disabled', code: 'URL_PREVIEW_DISABLED', id: '58b36e13-d2f5-0323-b0c6-76aa9dabefb8', kind: 'client',
				} }, 403);
			}
			if (!(error instanceof PreviewFailed)) {
				throw error;
			}
			c.header('Cache-Control', 'max-age=86400, immutable');
			return c.json({ error: {
				message: 'Failed to get preview', code: 'URL_PREVIEW_FAILED', id: '09d01cb5-53b9-4856-82e5-38a50c290a3b', kind: 'client',
			} }, 422);
		}
	});
}
