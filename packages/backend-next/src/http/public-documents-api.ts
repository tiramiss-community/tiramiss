/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { renderManifest, renderOpenSearch, renderRobots } from '../modules/public-documents/public.js';
import type { PublicDocumentSettings } from '../modules/public-documents/public.js';

export function createPublicDocumentsApi(options: { readSettings(): Promise<PublicDocumentSettings>; url: string }) {
	const host = new URL(options.url).host;
	return new Hono()
		.get('/manifest.json', async c => {
			const meta = await options.readSettings();
			let manifest: Record<string, unknown>;
			try {
				manifest = renderManifest(meta, host);
			} catch (error) {
				if (!(error instanceof SyntaxError)) {
					throw error;
				}
				// Malformed stored overrides use Fastify's ordinary error response upstream.
				return c.json({ statusCode: 500, error: 'Internal Server Error', message: error.message }, 500, { 'Content-Type': 'application/json; charset=utf-8' });
			}
			return c.json(manifest, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=300' });
		})
		.get('/robots.txt', async c => c.body(renderRobots(await options.readSettings()), 200, { 'Content-Type': 'text/plain; charset=utf-8' }))
		.get('/opensearch.xml', async c => c.body(renderOpenSearch(await options.readSettings(), options.url), 200, { 'Content-Type': 'application/opensearchdescription+xml' }));
}
