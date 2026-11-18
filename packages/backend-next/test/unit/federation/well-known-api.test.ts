/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { createWellKnownApi } from '../../../src/http/well-known-api.js';
import { wellKnownSource } from '../../helpers/well-known-source.js';

for (const sample of wellKnownSource.cases) {
	test(`pinned source ${sample.federation} ${sample.method} ${sample.path} at ${sample.url}`, async () => {
		const federationEnabled = vi.fn(async () => {
			if (sample.federation === 'fault') {
				throw new Error('private Meta database diagnostic');
			}
			return sample.federation !== 'none';
		});
		const logger = { error: vi.fn() };
		const app = createWellKnownApi({ selfUrl: sample.url, federationEnabled, logger });
		// These stand-ins assert registration order and common headers only; the
		// OAuth discovery business contract remains owned by its existing adapter.
		app.route('/', new Hono()
			.get('/.well-known/oauth-authorization-server', c => c.json({ issuer: sample.url }, 200, { 'Content-Type': 'application/json; charset=utf-8' }))
			.get('/.well-known/change-password', c => c.redirect(new URL('/settings/security', sample.url).toString(), 302)));
		const response = await app.request(sample.path, { method: sample.method });
		expect(response.status).toBe(sample.status);
		for (const [key, value] of Object.entries(sample.headers)) {
			if (sample.status !== 404 || key !== 'content-type') {
				expect(response.headers.get(key), key).toBe(sample.status === 500 && key === 'content-type' ? null : value);
			}
		}
		if (sample.body !== null) {
			expect(await response.text()).toBe(sample.body);
		}
		expect(federationEnabled).toHaveBeenCalledTimes(sample.metaReads);
		if (sample.status === 500) {
			expect(await response.text()).toBe('');
			expect(logger.error).toHaveBeenCalledExactlyOnceWith('host-meta.failed', { classification: 'unexpected-failure', stage: 'meta-read' });
		} else {
			expect(logger.error).not.toHaveBeenCalled();
		}
	});
}

test.each(['GET', 'HEAD', 'OPTIONS'])('outside discovery %s retains its own response and no discovery CORS', async method => {
	const app = createWellKnownApi({ selfUrl: 'https://example.test', logger: { error: vi.fn() }, federationEnabled: vi.fn() });
	const response = await app.request('/outside', { method });
	expect(response.status).toBe(404);
	expect(response.headers.get('access-control-allow-origin')).toBeNull();
});
