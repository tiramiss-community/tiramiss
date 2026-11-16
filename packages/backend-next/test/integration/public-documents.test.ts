/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { MiMeta } from 'backend-upstream/entities';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { readMeta } from '../../src/platform/database/meta.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';
import type { PublicDocumentSettings } from '../../src/modules/public-documents/public.js';

const directory = new URL('../../../../docs/superpowers/compatibility/public-documents/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	config: { url: string };
	defaults: PublicDocumentSettings;
	cases: { id: string; meta: Partial<PublicDocumentSettings> }[];
};
const observations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: { id: string; responses: { path: string; status: number; contentType: string; cacheControl: string | null; body: string }[] }[];
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let publisher: Redis;
let origin: string;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = corpus.config.url;
	resources = await connectResources(database.config, createLogger('public-documents-test', () => {}));
	publisher = new Redis(database.config.redisForPubsub);
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	publisher?.disconnect();
	await resources?.close();
	await database?.close();
});

test('missing Meta is created with upstream defaults and serves the default manifest', async () => {
	await resources.dataSource.getRepository(MiMeta).clear();
	await resources.meta.fetch(true);
	const response = await fetch(`${origin}/manifest.json`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(observations.cases[0].responses[0].body);
	expect(await resources.dataSource.getRepository(MiMeta).find()).toMatchObject([{ id: 'x' }]);
});

for (const item of observations.cases) {
	test(`ordinary composition / PostgreSQL / listening HTTP: ${item.id}`, async () => {
		const meta = { ...corpus.defaults, ...corpus.cases.find(input => input.id === item.id)!.meta };
		await resources.dataSource.getRepository(MiMeta).update('x', meta);
		await resources.meta.fetch(true);
		for (const expected of item.responses) {
			const response = await fetch(`${origin}${expected.path}`);
			expect({ path: expected.path, status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control'), body: await response.text() }).toEqual(expected);
		}
	});
}

test('warm documents use cached Meta, then authoritative Redis notification, then explicit reload', async () => {
	const repository = resources.dataSource.getRepository(MiMeta);
	await repository.update('x', { ...corpus.defaults, name: 'Saved' });
	const before = await resources.meta.fetch(true);
	expect((await (await fetch(`${origin}/manifest.json`)).json()).name).toBe('Saved');
	await repository.update('x', { name: 'Database changed', ugcVisibilityForVisitor: 'none' });
	expect((await (await fetch(`${origin}/manifest.json`)).json()).name).toBe('Saved');
	expect(await (await fetch(`${origin}/robots.txt`)).text()).not.toContain('Disallow: /notes\n');
	const after = { ...before, name: 'Notified & <name>', app192IconUrl: 'https://notified.test/icon.png', ugcVisibilityForVisitor: 'none' };
	await publisher.publish(new URL(corpus.config.url).host, JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before, after } } }));
	await vi.waitFor(async () => expect((await resources.meta.fetch()).name).toBe(after.name));
	expect((await (await fetch(`${origin}/manifest.json`)).json()).icons[0].src).toBe(after.app192IconUrl);
	expect(await (await fetch(`${origin}/robots.txt`)).text()).toContain('Disallow: /notes\n');
	expect(await (await fetch(`${origin}/opensearch.xml`)).text()).toContain('<ShortName>Notified & <name></ShortName>');
	expect((await readMeta(resources.dataSource.manager)).name).toBe('Database changed');
	await resources.meta.fetch(true);
	expect((await (await fetch(`${origin}/manifest.json`)).json()).name).toBe('Database changed');
});
