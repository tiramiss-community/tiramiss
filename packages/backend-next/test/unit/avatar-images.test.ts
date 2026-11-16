/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getPath } from 'hono/utils/url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createAvatarImagesApi, getAvatarImagesPath } from '../../src/http/avatar-images-api.js';
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

test('non-image request targets retain the existing Hono path resolver exactly', () => {
	for (const path of ['/outside/.', '/outside/..', '/outside/a\\b', '/api/notes/%2E%2E/show', '/fluent-emoji/a\\b']) {
		const request = new Request(`http://example.test${path}`);
		expect(getAvatarImagesPath(request, { env: { incoming: { url: path } } })).toBe(getPath(request));
	}
});

test('non-image raw dot/backslash GET and HEAD retain baseline Hono listening behavior', async () => {
	const baseline = new Hono().get('/outside/*', c => c.text(c.req.path));
	const scoped = new Hono({ getPath: getAvatarImagesPath }).get('/outside/*', c => c.text(c.req.path));
	const servers = [baseline, scoped].map(app => serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }));
	try {
		for (const instance of servers) {
			if (!instance.listening) {
				await new Promise<void>(resolve => instance.once('listening', resolve));
			}
		}
		const origins = servers.map(instance => `http://127.0.0.1:${(instance.address() as { port: number }).port}`);
		for (const path of ['/outside/.', '/outside/..', '/outside/a\\b']) {
			for (const method of ['GET', 'HEAD']) {
				const before = await imageRequest(origins[0], { path, method });
				const after = await imageRequest(origins[1], { path, method });
				expect({ status: after.status, body: after.body, type: after.headers['content-type'], length: after.headers['content-length'] }).toEqual({ status: before.status, body: before.body, type: before.headers['content-type'], length: before.headers['content-length'] });
			}
		}
	} finally {
		for (const instance of servers) {
			await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
		}
	}
});
