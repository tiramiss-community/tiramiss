/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { PreviewDisabled, PreviewFailed } from '../modules/url-preview/public.js';
import type { PreviewSummary } from '../modules/url-preview/public.js';

export function createUrlPreviewApi(application: { preview(url: string, lang?: string): Promise<PreviewSummary> }) {
	return new Hono().get('/url', async c => {
		const urls = c.req.queries('url');
		const langs = c.req.queries('lang');
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
