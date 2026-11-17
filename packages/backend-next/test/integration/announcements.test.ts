/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { MiAccessToken, MiAnnouncement, MiAnnouncementRead, MiUser } from 'backend-upstream/entities';
import corpus from '../../../../docs/superpowers/compatibility/announcements/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/announcements/observations.json' with { type: 'json' };
import { connectResources } from '../../src/platform/connect-resources.js';
import { drainHttpAppWork } from '../../src/composition/http-app-work.js';
import { createBackendHttpApp } from '../../src/composition/http-app.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { closeHttp, listenHttp } from '../../src/processes/http.js';
import { createTestDatabase } from '../helpers/database.js';
import type { Server } from 'node:http';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let server: Server;
let app: ReturnType<typeof createBackendHttpApp>;
let url: string;
let subscriber: Redis;
const events: unknown[] = [];
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, createLogger('announcement-test', () => {}));
	await resources.dataSource.getRepository(MiUser).insert(corpus.users.map(user => ({ ...user, usernameLower: user.username })));
	await resources.dataSource.getRepository(MiAccessToken).insert([
		{ id: 'scoped', userId: corpus.users[0].id, token: 'announcementwritetoken', hash: 'announcementwritetoken', permission: ['write:account'] },
		{ id: 'denied', userId: corpus.users[0].id, token: 'announcementreadtoken', hash: 'announcementreadtoken', permission: ['read:account'] },
	]);
	subscriber = new Redis({ host: database.config.redisForPubsub.host, port: database.config.redisForPubsub.port });
	subscriber.on('message', (topic, value) => events.push({ topic, ...JSON.parse(value) }));
	await subscriber.subscribe('example.test');
	app = createBackendHttpApp(resources, database.config);
	server = await listenHttp(app, { port: 0 });
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	if (server) {
		await closeHttp(server);
	}
	subscriber?.disconnect();
	await resources?.close();
	await database?.close();
});

async function request(endpoint: string, input: object = {}) {
	return fetch(`${url}/api/${endpoint}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
	});
}

test('canonical listening HTTP exposes public announcements', async () => {
	const response = await request('announcements');
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual([]);
});

for (const item of corpus.cases) {
	test(`normal HTTP / PostgreSQL / Redis match fixed upstream: ${item.id}`, async () => {
		const announcements = resources.dataSource.getRepository(MiAnnouncement);
		const reads = resources.dataSource.getRepository(MiAnnouncementRead);
		await reads.createQueryBuilder().delete().execute();
		await announcements.createQueryBuilder().delete().execute();
		if (item.rows.length) {
			await announcements.insert(item.rows.map(row => ({
				...row, icon: row.icon as MiAnnouncement['icon'], display: row.display as MiAnnouncement['display'],
				updatedAt: row.updatedAt ? new Date(row.updatedAt) : null, autoArchiveAt: row.autoArchiveAt ? new Date(row.autoArchiveAt) : null,
			})));
		}
		if (item.reads.length) {
			await reads.insert(item.reads);
		}
		const expected = observations.cases.find(expected => expected.id === item.id)!;
		for (const [index, step] of item.steps.entries()) {
			events.length = 0;
			const unavailable = 'failure' in item && item.failure === 'reads-unavailable';
			if (unavailable) {
				await resources.dataSource.query('ALTER TABLE announcement_read RENAME TO announcement_read_unavailable');
			}
			let response: Response;
			try {
				const viewer = 'viewer' in step ? step.viewer : null;
				const token = corpus.users.find(user => user.id === viewer)?.token;
				response = await request(step.endpoint, { ...step.input, ...(token ? { i: token } : {}) });
			} finally {
				if (unavailable) {
					await resources.dataSource.query('ALTER TABLE announcement_read_unavailable RENAME TO announcement_read');
				}
			}
			await subscriber.ping();
			const sourceStep = expected.steps[index];
			if ('error' in sourceStep && sourceStep.error) {
				expect(response.status).toBe(sourceStep.error.code === 'INTERNAL_ERROR' ? 500 : 400);
				expect((await response.json()).error).toMatchObject(sourceStep.error);
			} else {
				expect(response.status).toBe(sourceStep.value === null ? 204 : 200);
				expect(response.status === 204 ? null : await response.json()).toEqual(sourceStep.value);
			}
			expect(await resources.dataSource.query('SELECT id, "isActive", "updatedAt" FROM announcement ORDER BY id')).toEqual(
				sourceStep.rows.map(row => ({ ...row, updatedAt: row.updatedAt ? new Date(row.updatedAt) : null })),
			);
			expect(await resources.dataSource.query('SELECT "userId", "announcementId" FROM announcement_read ORDER BY "userId", "announcementId"')).toEqual(sourceStep.reads);
			expect(events).toEqual(sourceStep.events);
		}
	});
}

test('read gate enforces credential, token scopes and suspension before validation', async () => {
	for (const [i, code] of [[undefined, 'CREDENTIAL_REQUIRED'], ['invalidtoken', 'AUTHENTICATION_FAILED'], ['announcementreadtoken', 'PERMISSION_DENIED']] as const) {
		const response = await request('i/read-announcement', { i });
		expect((await response.json()).error.code).toBe(code);
	}
	await resources.dataSource.getRepository(MiUser).update(corpus.users[0].id, { isSuspended: true });
	try {
		const response = await request('i/read-announcement', { i: 'announcementreadtoken' });
		expect((await response.json()).error.code).toBe('YOUR_ACCOUNT_SUSPENDED');
		// Public reads, even authenticated ones, retain the pinned credential-free behavior.
		expect((await request('announcements', { i: corpus.users[0].token })).status).toBe(200);
	} finally {
		await resources.dataSource.getRepository(MiUser).update(corpus.users[0].id, { isSuspended: false });
	}
	const response = await request('i/read-announcement', { i: 'announcementwritetoken', announcementId: 'missing' });
	expect(response.status).toBe(204);
});

test('concurrent duplicate reads persist one row and emit one all-read message', async () => {
	const announcements = resources.dataSource.getRepository(MiAnnouncement);
	const reads = resources.dataSource.getRepository(MiAnnouncementRead);
	await reads.createQueryBuilder().delete().execute();
	await announcements.createQueryBuilder().delete().execute();
	await announcements.insert({ id: '6000000000000001', title: 'Concurrent', text: 'Concurrent', userId: corpus.users[0].id });
	events.length = 0;
	const responses = await Promise.all(Array.from({ length: 5 }, () => request('i/read-announcement', { i: corpus.users[0].token, announcementId: '6000000000000001' })));
	expect(responses.map(response => response.status)).toEqual([204, 204, 204, 204, 204]);
	await subscriber.ping();
	expect(await reads.count()).toBe(1);
	expect(await announcements.findOneByOrFail({ id: '6000000000000001' })).toMatchObject({ isActive: false });
	expect(events).toEqual([{ topic: 'example.test', channel: `mainStream:${corpus.users[0].id}`, message: { type: 'readAllAnnouncements', body: null } }]);
});

test('Redis publication rejection preserves successful reads and duplicate requests stay no-ops', async () => {
	const announcements = resources.dataSource.getRepository(MiAnnouncement);
	const reads = resources.dataSource.getRepository(MiAnnouncementRead);
	await reads.createQueryBuilder().delete().execute();
	await announcements.createQueryBuilder().delete().execute();
	const announcementId = '7000000000000001';
	await announcements.insert({ id: announcementId, title: 'Pubsub failure', text: 'Saved read', userId: corpus.users[0].id });
	const publish = vi.spyOn(resources.postingStream, 'main');
	const log = vi.spyOn(resources.logger, 'error');
	events.length = 0;
	await resources.redis.acl('SETUSER', 'default', '-publish');
	try {
		const response = await request('i/read-announcement', { i: corpus.users[0].token, announcementId });
		expect(response.status).toBe(204);
		await drainHttpAppWork(app);
		expect(await reads.findOneBy({ userId: corpus.users[0].id, announcementId })).not.toBeNull();
		expect(await announcements.findOneByOrFail({ id: announcementId })).toMatchObject({ isActive: false, updatedAt: null });
		const duplicate = await request('i/read-announcement', { i: corpus.users[0].token, announcementId });
		expect(duplicate.status).toBe(204);
		await drainHttpAppWork(app);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('announcement-publish.failed', expect.objectContaining({ userId: corpus.users[0].id }));
		expect(events).toEqual([]);
	} finally {
		await resources.redis.acl('SETUSER', 'default', '+publish');
		publish.mockRestore();
		log.mockRestore();
	}
});

test('normal HTTP finishes before publication and shutdown waits for accepted sends', async () => {
	const announcements = resources.dataSource.getRepository(MiAnnouncement);
	const reads = resources.dataSource.getRepository(MiAnnouncementRead);
	await reads.createQueryBuilder().delete().execute();
	await announcements.createQueryBuilder().delete().execute();
	const announcementId = '7000000000000002';
	await announcements.insert({ id: announcementId, title: 'Pending publication', text: 'Saved read' });
	let rejectDelivery!: (error: Error) => void;
	const pending = new Promise<void>((_resolve, reject) => {
		rejectDelivery = reject;
	});
	const publish = vi.spyOn(resources.postingStream, 'main').mockReturnValueOnce(pending);
	const local = await listenHttp(createBackendHttpApp(resources, database.config), { port: 0 });
	let closing: Promise<void> | undefined;
	try {
		const response = await fetch(`http://127.0.0.1:${(local.address() as { port: number }).port}/api/i/read-announcement`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ i: corpus.users[0].token, announcementId }), signal: AbortSignal.timeout(2000),
		});
		expect(response.status).toBe(204);
		expect(await reads.countBy({ userId: corpus.users[0].id, announcementId })).toBe(1);
		let closed = false;
		closing = closeHttp(local).then(() => {
			closed = true;
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(closed).toBe(false);
		rejectDelivery(Error('delivery failed after response'));
		await closing;
		expect(closed).toBe(true);
		expect(publish).toHaveBeenCalledTimes(1);
	} finally {
		rejectDelivery(Error('test cleanup'));
		await (closing ?? closeHttp(local));
		publish.mockRestore();
	}
});

test('upstream read uniqueness and cascading foreign keys survive copied entity registration', async () => {
	const announcements = resources.dataSource.getRepository(MiAnnouncement);
	const reads = resources.dataSource.getRepository(MiAnnouncementRead);
	await reads.createQueryBuilder().delete().execute();
	await announcements.createQueryBuilder().delete().execute();
	await announcements.insert({ id: '5000000000000001', title: 'FK test', text: 'Cascade', userId: corpus.users[1].id });
	await reads.insert({ id: 'firstread', userId: corpus.users[0].id, announcementId: '5000000000000001' });
	await expect(reads.insert({ id: 'secondread', userId: corpus.users[0].id, announcementId: '5000000000000001' })).rejects.toThrow();
	await expect(reads.insert({ id: 'missingannouncement', userId: corpus.users[0].id, announcementId: 'missing' })).rejects.toThrow();
	await expect(reads.insert({ id: 'missinguser', userId: 'missing', announcementId: '5000000000000001' })).rejects.toThrow();
	await resources.dataSource.getRepository(MiUser).delete(corpus.users[1].id);
	expect(await announcements.count()).toBe(0);
	expect(await reads.count()).toBe(0);
});
