/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createAvatarImagesApi } from '../../src/http/avatar-images-api.js';
import { genIdenticon } from '../../src/platform/images/identicon.js';
import { expectImageObservation, imageCorpus as corpus, imageRequest } from '../helpers/avatar-images.js';
import type { ImageCase } from '../helpers/avatar-images.js';

let active: ImageCase;
let origin: string;
let server: ReturnType<typeof serve>;
beforeAll(async () => {
	const app = createAvatarImagesApi({
		reader: {
			async emoji(name, host) {
				if (name === 'fail') {
					throw new Error('emoji lookup failed');
				}
				return corpus.emojis.find(emoji => emoji.name === name && emoji.host === host) ?? null;
			},
			async user(usernameLower, host) {
				if (usernameLower === 'fail') {
					throw new Error('avatar lookup failed');
				}
				return corpus.users.find(user => user.username.toLowerCase() === usernameLower && user.host === host && !user.isSuspended) ?? null;
			},
		},
		readSettings: async () => ({ ...corpus.meta, ...active.meta }),
		generate: seed => seed === 'failure' ? Promise.reject(new Error('identicon generation failed')) : genIdenticon(seed),
		url: corpus.config.url,
		get mediaProxy() {
			return active.mediaProxy ?? corpus.config.mediaProxy; 
		},
	});
	server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
	if (!server.listening) {
		await new Promise<void>(resolve => server.once('listening', resolve));
	}
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
for (const item of corpus.cases) {
	test(`listening image HTTP matches fixed source: ${item.id}`, async () => {
		active = item;
		await expectImageObservation(origin, item);
	});
}
test('identicon generation failure preserves cache and returns an ordinary JSON error', async () => {
	active = { id: 'failure', path: '/identicon/failure' };
	const response = await imageRequest(origin, active);
	expect(response.status).toBe(500);
	expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
	expect(response.headers['cache-control']).toBe('public, max-age=86400');
	expect(JSON.parse(response.body.toString())).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'identicon generation failed' });
});
