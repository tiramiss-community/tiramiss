/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiDriveFile, MiEmoji, MiMeta, MiUser } from 'backend-upstream/entities';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { expectImageObservation, imageCorpus as corpus, imageRequest } from '../helpers/avatar-images.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let publisher: Redis;
let origin: string;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	database.config.url = corpus.config.url;
	database.config.noteMedia = { mediaProxy: corpus.config.mediaProxy, externalMediaProxyEnabled: true };
	resources = await connectResources(database.config, createLogger('avatar-images-test', () => {}));
	publisher = new Redis(database.config.redisForPubsub);
	await resources.dataSource.getRepository(MiEmoji).insert(corpus.emojis.map((emoji, index) => ({ ...emoji, id: `emoji${index}` })));
	for (const [index, user] of corpus.users.entries()) {
		const id = `imageuser${index}`;
		await resources.dataSource.getRepository(MiUser).insert({ ...user, avatarId: null, id, usernameLower: user.username.toLowerCase() });
		if (user.avatarId != null) {
			const fileId = `imagefile${index}`;
			await resources.dataSource.getRepository(MiDriveFile).insert({ id: fileId, md5: '0'.repeat(32), name: 'avatar.png', type: 'image/png', size: 1, storedInternal: false, url: user.avatarUrl ?? 'https://images.test/unused.png' });
			await resources.dataSource.getRepository(MiUser).update(id, { avatarId: fileId });
		}
	}
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

// Controlled renderer/repository errors and invalid proxy configuration belong
// to the source/adapter comparison; real DB failures are exercised below.
for (const item of corpus.cases.filter(item => !/^(database-failure|avatar-db-failure|bad-proxy|generation-failure)(-head)?$/.test(item.id))) {
	test(`ordinary composition / PostgreSQL / listening image HTTP: ${item.id}`, async () => {
		await resources.dataSource.getRepository(MiMeta).update('x', { ...corpus.meta, ...item.meta });
		await resources.meta.fetch(true);
		await expectImageObservation(origin, item);
	});
}

test('public image redirects read fresh saved rows and propagate actual unavailable-table failures', async () => {
	await resources.dataSource.getRepository(MiEmoji).update('emoji0', { publicUrl: 'https://changed.test/emoji.webp' });
	expect((await imageRequest(origin, { path: '/emoji/wave.webp' })).headers.location).toContain('https%3A%2F%2Fchanged.test%2Femoji.webp');
	await resources.dataSource.getRepository(MiUser).update('imageuser0', { avatarUrl: 'https://changed.test/avatar.png' });
	expect((await imageRequest(origin, { path: '/avatar/@Alice' })).headers.location).toBe('https://changed.test/avatar.png');
	for (const [table, path, expectedCache] of [
		['emoji', '/emoji/wave.webp', 'public, max-age=86400'],
		['user', '/avatar/@Alice', undefined],
	] as const) {
		await resources.dataSource.query(`ALTER TABLE "${table}" RENAME TO "${table}_unavailable"`);
		try {
			for (const method of ['GET', 'HEAD']) {
				const response = await imageRequest(origin, { path, method });
				expect(response.status).toBe(500);
				expect(response.headers['cache-control']).toBe(expectedCache);
				expect(response.headers['content-security-policy']).toBeUndefined();
				if (method === 'GET') {
					expect(JSON.parse(response.body.toString())).toMatchObject({ statusCode: 500, code: '42P01', error: 'Internal Server Error' });
				} else {
					expect(response.body.length).toBe(0);
				}
			}
		} finally {
			await resources.dataSource.query(`ALTER TABLE "${table}_unavailable" RENAME TO "${table}"`);
		}
	}
});

test('warm image Meta changes after the existing authoritative Redis notification and explicit DB refresh', async () => {
	const repository = resources.dataSource.getRepository(MiMeta);
	await repository.update('x', corpus.meta);
	const before = await resources.meta.fetch(true);
	await repository.update('x', { enableIdenticonGeneration: false, iconUrl: 'https://database.test/icon.png' });
	expect((await imageRequest(origin, { path: '/identicon/seed' })).status).toBe(200);
	expect((await imageRequest(origin, { path: '/avatar/@System.Bot' })).headers.location).toBe(corpus.meta.iconUrl);
	const after = { ...before, enableIdenticonGeneration: false, iconUrl: 'https://notified.test/icon.png' };
	await publisher.publish(new URL(corpus.config.url).host, JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before, after } } }));
	await vi.waitFor(async () => expect((await resources.meta.fetch()).iconUrl).toBe(after.iconUrl));
	expect((await imageRequest(origin, { path: '/identicon/seed' })).headers.location).toBe('/static-assets/avatar.png');
	expect((await imageRequest(origin, { path: '/avatar/@System.Bot' })).headers.location).toBe(after.iconUrl);
	await resources.meta.fetch(true);
	expect((await imageRequest(origin, { path: '/avatar/@System.Bot' })).headers.location).toBe('https://database.test/icon.png');
});
