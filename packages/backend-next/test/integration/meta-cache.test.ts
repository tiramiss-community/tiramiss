/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { MiInstance, MiMeta, MiUser, MiUserKeypair, MiUserProfile } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { createDeliverJobHandler } from '../../src/composition/deliver-job.js';
import { readMeta } from '../../src/platform/database/meta.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import { freePort } from '../helpers/process.js';
import type { Server } from 'node:http';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let publisher: Redis;
let server: Server;
let url: string;
const id = 'metacache001';
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database);
	const port = await freePort(); url = `http://localhost:${port}`; database.config.url = url;
	resources = await connectResources(database.config, createLogger('meta-cache-test', () => {}));
	publisher = new Redis(database.config.redisForPubsub);
	await resources.dataSource.getRepository(MiMeta).insert({ id: 'z', federation: 'all', enableStatsForFederatedInstances: false, iconUrl: 'https://old.test/icon.png' });
	await resources.dataSource.getRepository(MiUser).insert({ id, username: 'instance.actor', usernameLower: 'alice' });
	await resources.dataSource.getRepository(MiUserProfile).insert({ userId: id });
	const pair = await generateRsaKeyPair();
	await resources.dataSource.getRepository(MiUserKeypair).insert({ userId: id, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	server = await listenHttp(createBackendHttpApp(resources, database.config), { port });
});
afterAll(async () => {
	if (server) {
		await closeHttp(server); 
	}
	publisher?.disconnect(); await resources?.close(); await database?.close();
});

async function notify(after: MiMeta) {
	await publisher.publish(new URL(url).host, JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before: { federation: 'none' }, after } } }));
	await vi.waitFor(async () => expect(await resources.meta.fetch()).toEqual({ ...JSON.parse(JSON.stringify(after)), rootUser: null }));
}

const discovery = () => fetch(`${url}/.well-known/webfinger?resource=alice`);
const actor = () => fetch(`${url}/users/${id}`, { headers: { Accept: 'application/activity+json' } });

test('warm real HTTP actor/WebFinger and delivery use after notifications instead of current DB', async () => {
	expect((await discovery()).status).toBe(200); expect((await actor()).status).toBe(200);
	const send = vi.spyOn(resources.outboundHttp, 'send').mockResolvedValue({} as never);
	const handler = createDeliverJobHandler(resources, database.config);
	const job = { user: { id }, to: 'https://remote.test/inbox', content: '{}', digest: 'digest', isSharedInbox: false };
	try {
		const original = await resources.meta.fetch();
		await resources.dataSource.getRepository(MiMeta).update('z', { federation: 'none' });
		expect((await discovery()).status).toBe(200); expect((await actor()).status).toBe(200);
		await notify({ ...original, federation: 'none' });
		expect((await discovery()).status).toBe(403); expect((await actor()).status).toBe(403);
		expect(await handler.process(job)).toEqual({ kind: 'done', result: 'skip (blocked)' }); expect(send).not.toHaveBeenCalled();
		// The after payload is authoritative even while the persisted row disagrees.
		await notify({ ...original, federation: 'all', iconUrl: 'https://notification.test/icon.png' });
		expect((await discovery()).status).toBe(200);
		expect(await (await actor()).json()).toMatchObject({ icon: { url: 'https://notification.test/icon.png' } });
		expect((await handler.process(job)).kind).toBe('done');
		expect(send).toHaveBeenCalledOnce();
		expect(await resources.dataSource.getRepository(MiInstance).findOneBy({ host: 'remote.test' })).toBeNull();
		expect((await readMeta(resources.dataSource.manager)).federation).toBe('none');
		await resources.meta.fetch(true); expect((await discovery()).status).toBe(403);
		await resources.dataSource.getRepository(MiMeta).update('z', { federation: 'all' }); await resources.meta.fetch(true);
	} finally {
		await handler.idle(); send.mockRestore(); 
	}
});

test('actor registration follows changing cached stats and does not register while disabled', async () => {
	const meta = await resources.meta.fetch(); const getJson = vi.spyOn(resources.outboundHttp, 'getJson').mockRejectedValue(new Error('test metadata unavailable'));
	try {
		await notify({ ...meta, federation: 'none', enableStatsForFederatedInstances: false });
		resources.actorInstanceRegistration.start('disabled.test'); await resources.actorInstanceRegistration.idle();
		expect(await resources.dataSource.getRepository(MiInstance).findOneBy({ host: 'disabled.test' })).toBeNull();
		await notify({ ...meta, federation: 'all', enableStatsForFederatedInstances: true });
		resources.actorInstanceRegistration.start('enabled.test'); await resources.actorInstanceRegistration.idle();
		expect(await resources.dataSource.getRepository(MiInstance).findOneByOrFail({ host: 'enabled.test' })).toMatchObject({ usersCount: 1 });
		expect((await readMeta(resources.dataSource.manager)).enableStatsForFederatedInstances).toBe(false);
	} finally {
		getJson.mockRestore(); await resources.meta.fetch(true); 
	}
});

test('production periodic reload changes ordinary HTTP after a missed notification, reports DB failure and stops', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	vi.stubEnv('NODE_ENV', 'production');
	const logger = { info: vi.fn(), error: vi.fn() };
	const live = await connectResources(database.config, logger);
	vi.unstubAllEnvs();
	const liveServer = await listenHttp(createBackendHttpApp(live, database.config), { port: 0 });
	const livePort = (liveServer.address() as { port: number }).port;
	const request = () => fetch(`http://127.0.0.1:${livePort}/.well-known/webfinger?resource=alice`);
	try {
		expect((await request()).status).toBe(200);
		const initial = await live.meta.fetch(); await resources.dataSource.query('ALTER TABLE "meta" RENAME TO "meta_cache_fault"');
		try {
			expect((await request()).status).toBe(200); await expect(live.meta.fetch(true)).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(300000);
			await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith('meta-cache.reload-failed', expect.anything()));
			expect(await live.meta.fetch()).toEqual(initial);
		} finally {
			await resources.dataSource.query('ALTER TABLE "meta_cache_fault" RENAME TO "meta"'); 
		}
		await resources.dataSource.getRepository(MiMeta).update('z', { federation: 'none' });
		expect((await request()).status).toBe(200);
		await vi.advanceTimersByTimeAsync(300000); await vi.waitFor(async () => expect((await request()).status).toBe(403));
		await closeHttp(liveServer); await live.close(); logger.error.mockClear();
		await resources.dataSource.query('ALTER TABLE "meta" RENAME TO "meta_cache_fault"');
		try {
			await vi.advanceTimersByTimeAsync(600000); expect(logger.error).not.toHaveBeenCalled(); 
		} finally {
			await resources.dataSource.query('ALTER TABLE "meta_cache_fault" RENAME TO "meta"'); 
		}
	} finally {
		if (liveServer.listening) {
			await closeHttp(liveServer); 
		} await live.close(); vi.unstubAllEnvs(); vi.useRealTimers(); 
	}
});
