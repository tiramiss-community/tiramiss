/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { MiAccessToken, MiUserProfile } from 'backend-upstream/entities';
import { connectResources } from '../../src/platform/connect-resources.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { openQueueHttp } from '../../src/composition/queue-http.js';
import { createBackendHttpApp } from '../../src/composition/note-http.js';
import { openPostingWebSocket } from '../../src/composition/posting-websocket.js';
import { closeHttp, listenHttp, registerHttpDrain } from '../../src/processes/http.js';
import { baseQueueOptions, baseWorkerOptions } from '../../src/platform/job-queue/connection.js';
import { openQueueAdministration } from '../../src/platform/job-queue/administration.js';
import { openQueueStats } from '../../src/platform/queue-stats.js';
import { createTestDatabase } from '../helpers/database.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { QueueName } from '../../src/modules/queue/public.js';

const corpus = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/queue-admin/observations.json', import.meta.url), 'utf8')) as { observations: { id: string; layer: string; input: any; expected: any }[] };
const logger = { info() { }, error() { } };
const delay = () => new Promise(resolve => setTimeout(resolve, 25));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let resources: Awaited<ReturnType<typeof connectResources>>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase();
	database.config.redisForJobQueue = { ...database.config.redis, db: 2, prefix: `${database.config.redis.prefix}-queues` };
	await migrateDatabase(database.config.database);
	resources = await connectResources(database.config, logger);
	seeded = await seedRoleHttp(resources.dataSource);
	for (const actor of Object.values(seeded.actors)) {
		if (actor.id && !actor.token.includes('access') && !actor.token.includes('APP')) {
			await resources.dataSource.getRepository(MiUserProfile).upsert({ userId: actor.id, userHost: null }, ['userId']);
		}
	}
	await resources.dataSource.getRepository(MiAccessToken).insert({ id: seeded.codec.newId(Date.now()), userId: seeded.actors.ordinary.id, token: 'queue-ws-read-account', hash: 'queue-ws-read-account-hash', permission: ['read:account'] });
});
afterAll(async () => {
	await resources?.close(); await database?.close();
});
afterEach(() => {
	vi.useRealTimers();
});

async function start() {
	const queueHttp = await openQueueHttp(resources, database.config, () => { });
	const server = await listenHttp(createBackendHttpApp(resources, database.config, queueHttp.api), database.config.http);
	const streaming = await openPostingWebSocket(server, resources, database.config, () => { }, queueHttp.stats);
	registerHttpDrain(server, streaming.close);
	const port = (server.address() as { port: number }).port;
	let closing: Promise<void> | undefined;
	return {
		queueHttp, port, close: () => closing ??= (async () => {
			await closeHttp(server); await queueHttp.close();
		})()
	};
}

async function connect(port: number, token?: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/streaming${token ? `?i=${token}` : ''}`);
	const messages: any[] = [];
	socket.on('message', data => messages.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => {
		socket.once('open', resolve); socket.once('error', reject);
	});
	return {
		socket, messages, send(type: string, body: unknown) {
			socket.send(JSON.stringify({ type, body }));
		}
	};
}

test.each(corpus.observations.filter(o => o.layer === 'stream-upgrade'))('fixed-source $id on a real WebSocket handshake', async observation => {
	const running = await start();
	const actor = observation.input.actor;
	const token = actor === 'anonymous' ? undefined : actor === 'read-account-app' ? 'queue-ws-read-account' : actor === 'unscoped-app' ? seeded.actors.ordinaryNoScope.token : actor === 'invalid-token' ? 'invalid-token' : seeded.actors[actor === 'member' ? 'ordinary' : actor].token;
	const socket = new WebSocket(`ws://127.0.0.1:${running.port}/streaming${token ? `?i=${token}` : ''}`);
	const result = await new Promise<{ upgraded: boolean; status?: number; challenge?: string }>(resolve => {
		socket.once('open', () => resolve({ upgraded: true }));
		socket.once('unexpected-response', (_req, response) => {
			response.resume(); resolve({ upgraded: false, status: response.statusCode, challenge: response.headers['www-authenticate'] });
		});
		socket.on('error', () => { });
	});
	try {
		expect(result.upgraded).toBe(observation.expected.upgraded);
		if (!result.upgraded) {
			expect(result.status).toBe(Number(observation.expected.writes[0].split(' ')[1]));
			if (result.status === 401) {
				expect(result.challenge).toBe('Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"');
			}
		}
	} finally {
		socket.terminate(); await running.close();
	}
});

test('guest and read-account-only actor receive real active stats and log with isolated channel ids', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const running = await start();
	const guest = await connect(running.port);
	const member = await connect(running.port, 'queue-ws-read-account');
	const q = new Queue('deliver', baseQueueOptions(database.config.redisForJobQueue, 'deliver', 5000));
	const inbox = new Queue('inbox', baseQueueOptions(database.config.redisForJobQueue, 'inbox', 5000));
	const control = new Redis({ ...database.config.redisForJobQueue, keyPrefix: undefined });
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	let worker: Worker | undefined;
	try {
		guest.send('connect', { id: 'guest-stats', channel: 'queueStats', pong: true });
		member.send('connect', { id: 'member-stats', channel: 'queueStats', pong: true });
		await vi.waitFor(() => {
			expect(guest.messages).toHaveLength(1); expect(member.messages).toHaveLength(1);
		});
		await vi.waitFor(async () => expect(String(await control.client('LIST')).split('\n').filter(line => line.includes(database.config.redisForJobQueue.prefix!) && line.includes('cmd=xread'))).toHaveLength(2));
		await q.add('active', { content: 'private-payload-never-in-stats' });
		await q.add('waiting', {}); await q.add('delayed', {}, { delay: 600000 }); await inbox.add('incoming', {}, { delay: 600000 });
		worker = new Worker('deliver', async () => held, { ...baseWorkerOptions(database.config.redisForJobQueue, 'deliver', 5000), concurrency: 1 });
		await vi.waitFor(async () => expect((await q.getJobCounts('active')).active).toBe(1));
		await vi.waitFor(async () => {
			await vi.advanceTimersByTimeAsync(10000); await delay(); expect(guest.messages.some(message => message.body?.body?.deliver?.activeSincePrevTick === 1)).toBe(true);
		});
		const stats = guest.messages.find(message => message.body?.body?.deliver?.activeSincePrevTick === 1);
		expect(stats).toEqual({ type: 'channel', body: { id: 'guest-stats', type: 'stats', body: { deliver: { activeSincePrevTick: 1, active: 1, waiting: 1, delayed: 1 }, inbox: { activeSincePrevTick: 0, active: 0, waiting: 0, delayed: 1 } } } });
		expect(member.messages).toContainEqual({ ...stats, body: { ...stats.body, id: 'member-stats' } });
		expect(JSON.stringify(stats)).not.toContain('private-payload');
		guest.send('ch', { id: 'guest-stats', type: 'requestLog', body: { id: 'request-correlation', length: 1 } });
		await vi.waitFor(() => expect(guest.messages.some(message => message.body?.type === 'statsLog')).toBe(true));
		expect(guest.messages.find(message => message.body?.type === 'statsLog').body.body).toEqual(running.queueHttp.stats.readLog(1));
		expect(member.messages.some(message => message.body?.type === 'statsLog')).toBe(false);
		guest.send('disconnect', { id: 'guest-stats' });
		await delay(); const sent = guest.messages.length;
		await vi.advanceTimersByTimeAsync(10000); await delay();
		expect(guest.messages).toHaveLength(sent);
		expect(member.messages.at(-1).body.type).toBe('stats');
	} finally {
		release(); await worker?.close(); guest.socket.terminate(); member.socket.terminate(); await running.close(); await q.obliterate({ force: true }); await inbox.obliterate({ force: true }); await q.close(); await inbox.close(); control.disconnect();
	}
});

test('failed registry and QueueEvents startup release owned Redis connections', async () => {
	const wrong = { ...database.config.redisForJobQueue, username: 'missing-test-user', password: 'incorrect' };
	await expect(openQueueAdministration({ redis: wrong, connectTimeoutMs: 1000, logger, onLost() { } })).rejects.toThrow();
	await expect(openQueueStats({ redis: wrong, connectTimeoutMs: 1000, logger, counts: async () => ({}), onLost() { } })).rejects.toThrow();
	const control = new Redis(database.config.redis);
	try {
		expect(String(await control.client('LIST'))).not.toContain(`name=${database.config.redisForJobQueue.prefix}:queue-admin:`);
	} finally {
		control.disconnect();
	}
});
