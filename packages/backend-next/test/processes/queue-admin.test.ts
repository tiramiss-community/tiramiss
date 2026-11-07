/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: Awaited<ReturnType<ReturnType<typeof createDataSource>['initialize']>>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
beforeAll(async () => {
	database = await createTestDatabase(); await migrateDatabase(database.config.database); source = await createDataSource(database.config.database).initialize(); seeded = await seedRoleHttp(source);
});
afterAll(async () => {
	await source?.destroy(); await database?.close();
});

async function processConfig(shutdownTimeoutMs = 5000) {
	const prefix = `queue-admin-process-${randomUUID()}`;
	const value = { ...database.config, http: { port: await freePort() }, redisForJobQueue: { ...database.config.redisForJobQueue, db: 3, prefix, keyPrefix: `${prefix}:` }, processes: { ...database.config.processes, shutdownTimeoutMs } };
	return { value, file: await configuration(value) };
}

function message(child: ReturnType<typeof launch>, type: string) {
	return new Promise<void>(resolve => {
		if (child.messages.some(value => value && typeof value === 'object' && 'type' in value && value.type === type)) {
			resolve(); return;
		}
		child.child.on('message', value => {
			if (value && typeof value === 'object' && 'type' in value && value.type === type) {
				resolve();
			}
		});
	});
}

test('normal HTTP process serves every registered queue API and guest QueueStats log', async () => {
	const { value, file } = await processConfig();
	const http = launch('built/entrypoints/http.js', file.path);
	let socket: WebSocket | undefined;
	const q = new Queue('db', baseQueueOptions(value.redisForJobQueue, 'db', 5000));
	try {
		await http.ready;
		const corpus = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/queue-admin/observations.json', import.meta.url), 'utf8'));
		for (const route of corpus.metadata) {
			const suffix = route.name.split('/').at(-1);
			if (suffix === 'show-job') {
				await q.add('process retained', {}, { jobId: 'process-job' });
			}
			const params = suffix === 'jobs' ? { queue: 'db', state: ['wait'] } : suffix === 'clear' ? { queue: 'db', state: 'failed' } : { queue: 'db', jobId: 'process-job' };
			const response = await fetch(`http://127.0.0.1:${value.http.port}/api/${route.name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: seeded.actors.root.token, ...params }) });
			expect(response.status, suffix).toBe(['clear', 'retry-job', 'remove-job', 'promote-jobs', 'pause', 'resume'].includes(suffix) ? 204 : 200);
		}
		socket = new WebSocket(`ws://127.0.0.1:${value.http.port}/streaming`);
		const messages: any[] = [];
		socket.on('message', data => messages.push(JSON.parse(data.toString())));
		await new Promise<void>((resolve, reject) => {
			socket!.once('open', resolve); socket!.once('error', reject);
		});
		socket.send(JSON.stringify({ type: 'connect', body: { id: 'public-stats', channel: 'queueStats', pong: true } }));
		socket.send(JSON.stringify({ type: 'channel', body: { id: 'public-stats', type: 'requestLog', body: { id: 'log', length: 1 } } }));
		await vi.waitFor(() => expect(messages.some(value => value.body?.type === 'statsLog' && value.body.body.length === 1)).toBe(true));
		http.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	} finally {
		socket?.terminate(); await http.close(); await q.obliterate({ force: true }); await q.close(); await file.close();
	}
});

test.each(['registry', 'events'] as const)('losing the HTTP %s Redis connection stops the full process tree', async kind => {
	const { value, file } = await processConfig();
	const supervisor = launch('built/entrypoints/supervisor.js', file.path);
	const control = new Redis(database.config.redis);
	let children: { pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((m: any) => m.role === 'supervisor') as { children: typeof children }).children;
		let victim: string | undefined;
		await vi.waitFor(async () => {
			victim = String(await control.client('LIST')).split('\n').find(line => kind === 'registry' ? line.includes(`name=${value.redisForJobQueue.prefix}:queue-admin:system `) : line.includes(value.redisForJobQueue.prefix) && line.includes('cmd=xread'));
			expect(victim).toBeDefined();
		});
		await control.client('KILL', 'ID', victim!.match(/^id=(\d+)/)![1]);
		expect((await supervisor.exit).code, supervisor.output()).toBe(1);
		expect(supervisor.output()).toContain('QUEUE_ADMIN_REDIS_ENDED');
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		control.disconnect(); await supervisor.close(); for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch { }
		} await file.close();
	}
});

test.each(['pause', 'detached', 'stats'] as const)('SIGTERM waits for started %s work and releases resources after IPC release', async gate => {
	const { value, file } = await processConfig();
	const http = launch('test/fixtures/queue-admin-http.mjs', file.path, { QUEUE_FIXTURE_GATE: gate });
	const q = new Queue('db', baseQueueOptions(value.redisForJobQueue, 'db', 5000));
	const control = new Redis(database.config.redis);
	let response: Promise<Response> | undefined;
	try {
		await http.ready;
		if (gate !== 'stats') {
			await q.add('pending', {}, { jobId: 'pending' });
			response = fetch(`http://127.0.0.1:${value.http.port}/api/admin/queue/${gate === 'pause' ? 'pause' : 'remove-job'}`, { method: 'POST', body: JSON.stringify({ i: seeded.actors.root.token, queue: 'db', jobId: 'pending' }), headers: { 'Content-Type': 'application/json' } });
			void response.catch(() => { });
		}
		await message(http, 'operation-entered');
		if (gate === 'detached') {
			expect((await response!).status).toBe(204);
		}
		http.child.kill('SIGTERM'); await message(http, 'draining');
		// The drain notification is an explicit barrier; no elapsed-time assumption establishes acceptance.
		expect(http.child.exitCode).toBeNull();
		expect(http.messages.some((m: any) => m.type === 'drained')).toBe(false);
		http.child.send({ type: 'probe-timers' }); await message(http, 'timers-probed');
		expect((http.messages.find((m: any) => m.type === 'timers-probed') as { registered: number }).registered).toBe(0);
		http.child.send({ type: 'release' });
		expect((await http.exit).code, http.output()).toBe(0);
		if (gate === 'pause') {
			expect((await response!).status).toBe(204); expect(await q.isPaused()).toBe(true);
		}
		if (gate === 'detached') {
			expect(await q.getJob('pending')).toBeUndefined();
		}
		expect(String(await control.client('LIST'))).not.toContain(`name=${value.redisForJobQueue.prefix}:queue-admin:`);
		expect(String(await control.client('LIST')).split('\n').filter(line => line.includes(value.redisForJobQueue.prefix) && line.includes('cmd=xread'))).toEqual([]);
	} finally {
		await http.close(); control.disconnect(); await q.obliterate({ force: true }); await q.close(); await file.close();
	}
});

test('a never-released detached operation obeys shutdown deadline and leaves retained work', async () => {
	const { value, file } = await processConfig(200);
	const http = launch('test/fixtures/queue-admin-http.mjs', file.path, { QUEUE_FIXTURE_GATE: 'detached' });
	const q = new Queue('db', baseQueueOptions(value.redisForJobQueue, 'db', 5000));
	try {
		await http.ready; await q.add('pending', {}, { jobId: 'pending' });
		const response = fetch(`http://127.0.0.1:${value.http.port}/api/admin/queue/remove-job`, { method: 'POST', body: JSON.stringify({ i: seeded.actors.root.token, queue: 'db', jobId: 'pending' }), headers: { 'Content-Type': 'application/json' } });
		await message(http, 'operation-entered'); expect((await response).status).toBe(204);
		http.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(1);
		expect(http.output()).toContain('shutdown.timeout'); expect(await q.getJob('pending')).toBeDefined();
	} finally {
		await http.close(); await q.obliterate({ force: true }); await q.close(); await file.close();
	}
});

test('partial administration startup failure exits without ready and releases created connections', async () => {
	const { value, file } = await processConfig();
	const http = launch('test/fixtures/queue-admin-http.mjs', file.path, { QUEUE_FIXTURE_GATE: 'startup' });
	const control = new Redis(database.config.redis);
	try {
		expect((await http.exit).code, http.output()).toBe(1);
		expect(http.messages.some((m: any) => m.type === 'ready')).toBe(false);
		expect(http.output()).toContain('startup.failed');
		expect(String(await control.client('LIST'))).not.toContain(value.redisForJobQueue.prefix);
	} finally {
		await http.close(); control.disconnect(); await file.close();
	}
});
