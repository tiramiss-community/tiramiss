/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MiUser, MiWebhook } from 'backend-upstream/entities';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createOutboundHttpClient } from '../../src/composition/outbound-http.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createLogger } from '../../src/platform/logger.js';
import { createUserWebhookProcessor, USER_WEBHOOK_DELIVER } from '../../src/platform/job-queue/user-webhook.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { openUserWebhooks } from '../../src/platform/user-webhooks.js';
import { createTestDatabase } from '../helpers/database.js';
import { openBusinessJobProducers, openUserWebhookWorker } from '../helpers/business-jobs.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let server: ReturnType<typeof createServer>;
let url: string;
const requests: { headers: any; body: any }[] = [];
let responseStatus = 204;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = createDataSource(database.config.database);
	await source.initialize();
	server = createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) {
			body += chunk;
		}
		requests.push({ headers: req.headers, body: JSON.parse(body) });
		res.writeHead(responseStatus).end();
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
});
afterAll(async () => {
	server?.close(); await source?.destroy(); await database?.close();
});

test('real queue retains a captured hook through disable/delete and retries transient response', async () => {
	await source.getRepository(MiUser).insert({ id: 'owner', username: 'owner', usernameLower: 'owner' });
	await source.getRepository(MiWebhook).insert({ id: 'hook', userId: 'owner', name: 'hook', active: true, on: ['note'], url, secret: 'secret' });
	const logger = createLogger('webhook-test', () => {});
	const connection = { redis: database.config.redisForJobQueue, connectTimeoutMs: 10000, logger };
	const queue = openBusinessJobProducers({ ...connection, onLost: () => {} });
	await queue.ready();
	const hooks = await openUserWebhooks({ manager: source.manager, redis: database.config.redisForPubsub, url: database.config.url, timeoutMs: 10000, enqueue: queue.enqueueWebhook });
	const inspect = new Queue(USER_WEBHOOK_DELIVER, baseQueueOptions(connection.redis, USER_WEBHOOK_DELIVER, 10000));
	const processor = createUserWebhookProcessor({
		send: createOutboundHttpClient(database.config).send, url: database.config.url,
		update: async (id, status) => {
			await source.getRepository(MiWebhook).update({ id }, { latestSentAt: new Date(), latestStatus: status });
		}, report: () => {},
	});
	let stop: (() => Promise<void>) | undefined;
	try {
		await hooks.enqueue('owner', 'note', { id: 'saved' });
		await source.getRepository(MiWebhook).delete({ id: 'hook' });
		responseStatus = 429;
		stop = await openUserWebhookWorker({ ...connection, process: processor.process, reportFailure: error => {
			throw error;
		} });
		await vi.waitFor(async () => expect(await inspect.getDelayedCount()).toBe(1));
		const delayed = await inspect.getDelayed();
		expect(delayed[0].attemptsMade).toBe(1);
		responseStatus = 204;
		await delayed[0].promote();
		await vi.waitFor(async () => expect(await inspect.getCompletedCount()).toBe(1));
		expect(requests).toHaveLength(2);
		expect(requests[0].headers['x-misskey-hook-secret']).toBe('secret');
		expect(requests[0].body).toEqual(requests[1].body);
		expect(requests[0].body).toMatchObject({ hookId: 'hook', userId: 'owner', type: 'note', body: { note: { id: 'saved' } } });
	} finally {
		await stop?.(); await processor.idle(); await hooks.close(); await queue.close(); await inspect.close();
	}
});

test('while connected, the lazy hook cache changes only after internal update and delete messages', async () => {
	await source.getRepository(MiWebhook).insert({ id: 'cache-hook', userId: 'owner', name: 'cache', active: true, on: ['note'], url, secret: 'old' });
	const observed: string[] = [];
	const hooks = await openUserWebhooks({ manager: source.manager, redis: database.config.redisForPubsub, url: database.config.url, timeoutMs: 10000, enqueue: async hook => {
		observed.push(hook.secret);
	} });
	const publisher = new Redis(database.config.redisForPubsub);
	const publish = (type: string, body: object) => publisher.publish(new URL(database.config.url).host, JSON.stringify({ channel: 'internal', message: { type, body } }));
	try {
		await hooks.enqueue('owner', 'note', {});
		await hooks.enqueue('other', 'note', {});
		await hooks.enqueue('owner', 'reply', {});
		await source.getRepository(MiWebhook).update({ id: 'cache-hook' }, { active: false, secret: 'new' });
		await hooks.enqueue('owner', 'note', {});
		expect(observed).toEqual(['old', 'old']);
		const row = await source.getRepository(MiWebhook).findOneByOrFail({ id: 'cache-hook' });
		await publish('webhookUpdated', row);
		await vi.waitFor(async () => {
			observed.length = 0;
			await hooks.enqueue('owner', 'note', {});
			expect(observed).toEqual([]);
		});
		await publish('webhookUpdated', { ...row, active: true });
		await vi.waitFor(async () => {
			observed.length = 0;
			await hooks.enqueue('owner', 'note', {});
			expect(observed).toEqual(['new']);
		});
		await publish('webhookDeleted', row);
		await vi.waitFor(async () => {
			observed.length = 0;
			await hooks.enqueue('owner', 'note', {});
			expect(observed).toEqual([]);
		});
		await publish('webhookCreated', { ...row, active: true, secret: 'created' });
		await vi.waitFor(async () => {
			observed.length = 0;
			await hooks.enqueue('owner', 'note', {});
			expect(observed).toEqual(['created']);
		});
	} finally {
		await hooks.close(); publisher.disconnect();
	}
});

test('reconnecting the subscriber reloads disabled, deleted and changed hooks without internal messages', async () => {
	await source.getRepository(MiUser).insert({ id: 'reconnect-owner', username: 'reconnect', usernameLower: 'reconnect' });
	const row = { userId: 'reconnect-owner', name: 'reconnect', active: true, on: ['note' as const], url, secret: 'old' };
	await source.getRepository(MiWebhook).insert([
		{ ...row, id: 'reconnect-disabled' },
		{ ...row, id: 'reconnect-deleted' },
		{ ...row, id: 'reconnect-changed' },
	]);
	const observed: { id: string; secret: string }[] = [];
	const hooks = await openUserWebhooks({ manager: source.manager, redis: database.config.redisForPubsub, url: database.config.url, timeoutMs: 10000, enqueue: async hook => {
		observed.push({ id: hook.id, secret: hook.secret });
	} });
	const control = new Redis(database.config.redisForPubsub);
	const subscriberIds = async () => {
		const clients = await control.client('LIST') as string;
		return clients.split('\n').filter(line => /\bsub=1\b/.test(line)).map(line => /\bid=(\d+)/.exec(line)![1]);
	};
	try {
		await hooks.enqueue('reconnect-owner', 'note', {});
		expect(observed).toHaveLength(3);
		await source.getRepository(MiWebhook).update({ id: 'reconnect-disabled' }, { active: false });
		await source.getRepository(MiWebhook).delete({ id: 'reconnect-deleted' });
		await source.getRepository(MiWebhook).update({ id: 'reconnect-changed' }, { secret: 'new' });
		const oldIds = await subscriberIds();
		expect(oldIds).toHaveLength(1);
		await control.client('KILL', 'ID', oldIds[0]);
		await vi.waitFor(async () => {
			const current = await subscriberIds();
			expect(current).toHaveLength(1);
			expect(current[0]).not.toBe(oldIds[0]);
		}, { timeout: 10000 });
		observed.length = 0;
		await hooks.enqueue('reconnect-owner', 'note', {});
		expect(observed).toEqual([{ id: 'reconnect-changed', secret: 'new' }]);
	} finally {
		await hooks.close();
		control.disconnect();
	}
});
