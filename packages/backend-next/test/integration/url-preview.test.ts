/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import { serve } from '@hono/node-server';
import { MiMeta } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from '../helpers/database.js';
import type { AddressInfo } from 'node:net';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: ReturnType<typeof serve>;
let origin: string;
let peerOrigin: string;
const requests: URL[] = [];
const peer = createServer((request, response) => {
	const url = new URL(request.url!, 'http://local'); requests.push(url);
	if (url.pathname === '/summary') {
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ url: 'https://result.test/sensitive', title: 'Proxy title', player: { url: 'https://player.test' }, icon: '', thumbnail: 'https://img.test/thumbnail', extra: { arbitrary: true } }));
		return;
	}
	response.setHeader('Content-Type', 'text/html');
	response.end('<html><head><title>Real DB Summaly title</title></head></html>');
});
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
	peerOrigin = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
	database.config.noteMedia = { mediaProxy: 'https://media.test', externalMediaProxyEnabled: true };
	resources = await connectResources(database.config, createLogger('preview-test', () => {}));
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'singleton', urlPreviewSummaryProxyUrl: `${peerOrigin}/summary` });
	const app = createBackendHttpApp(resources, database.config);
	server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
	await new Promise<void>(resolve => server.once('listening', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
	await resources?.close();
	await new Promise<void>((resolve, reject) => {
		peer.closeAllConnections(); peer.close(error => error ? reject(error) : resolve()); 
	});
	await database?.close();
});
test('ordinary public HTTP uses persisted eight Meta settings, cached conversion and current settings updates', async () => {
	const repository = resources.dataSource.getRepository(MiMeta);
	await repository.update('singleton', { urlPreviewAllowRedirect: false, urlPreviewTimeout: 123, urlPreviewMaximumContentLength: 456, urlPreviewRequireContentLength: true, urlPreviewUserAgent: 'DB UA +', urlPreviewSensitiveList: ['result.test sensitive'] });
	const before = requests.length;
	const response = await fetch(`${origin}/url?url=https%3A%2F%2Finput.test&lang=fr`);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ sensitive: true, icon: 'https://media.test/preview.webp?url=&preview=1', thumbnail: 'https://media.test/preview.webp?url=https%3A%2F%2Fimg.test%2Fthumbnail&preview=1', player: { url: 'https://player.test' }, extra: { arbitrary: true } });
	expect(Object.fromEntries(requests[before].searchParams)).toEqual({ url: 'https://input.test', lang: 'fr', followRedirects: 'false', userAgent: 'DB UA +', operationTimeout: '123', contentLengthLimit: '456', contentLengthRequired: 'true' });
	await repository.update('singleton', { urlPreviewSensitiveList: [] });
	expect(await (await fetch(`${origin}/url?url=https%3A%2F%2Finput.test&lang=fr`)).json()).toHaveProperty('sensitive', false);
	expect(requests.length).toBe(before + 1);
	await repository.update('singleton', { urlPreviewEnabled: false });
	expect((await fetch(`${origin}/url?url=https%3A%2F%2Finput.test&lang=fr`)).status).toBe(403);
	expect((await fetch(`${origin}/url`)).status).toBe(400);
	await repository.update('singleton', { urlPreviewEnabled: true, urlPreviewSummaryProxyUrl: null, urlPreviewTimeout: 1000, urlPreviewMaximumContentLength: 10485760, urlPreviewRequireContentLength: false, urlPreviewUserAgent: null });
	const direct = await fetch(`${origin}/url?url=${encodeURIComponent(`${peerOrigin}/direct`)}`);
	expect(direct.status).toBe(200);
	expect(await direct.json()).toHaveProperty('title', 'Real DB Summaly title');
});
test('ordinary HEAD performs acquisition while returning empty body, malformed query rejects and POST remains unmatched', async () => {
	await resources.dataSource.getRepository(MiMeta).update('singleton', { urlPreviewSummaryProxyUrl: `${peerOrigin}/summary` });
	const before = requests.length;
	const head = await fetch(`${origin}/url?url=head-unique`, { method: 'HEAD' });
	expect(head.status).toBe(200); expect(await head.text()).toBe('');
	expect(head.headers.get('cache-control')).toBe('max-age=86400, immutable');
	expect(requests.length).toBe(before + 1);
	for (const query of ['url=a&url=b', 'url=a&lang=en&lang=ja', 'url[]=a']) {
		const response = await fetch(`${origin}/url?${query}`);
		expect(response.status).toBe(400); expect(await response.text()).toBe('');
		expect(response.headers.get('content-type')).toBeNull();
	}
	expect((await fetch(`${origin}/url?url=x`, { method: 'POST' })).status).toBe(404);
});
