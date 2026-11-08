/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MiMeta, MiNote, MiUserKeypair, MiUserProfile, MiWebhook } from 'backend-upstream/entities';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { inspectQueueHandoff } from '../../src/platform/job-queue/handoff.js';
import { generateRsaKeyPair } from '../../src/platform/key-pair.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { RuntimeConfig } from '../../src/config/types.js';

const execute = promisify(execFile);
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '--recorded';
const generator = resolve('../../docs/superpowers/compatibility/queue-handoff/generate-bullmq.cjs');
interface StoredJob { id: string;
	name: string;
	data: Record<string, any>;
	opts: Record<string, unknown> }
interface Receipt {
	sourceCommit: string;
	bullmqVersion: string;
	mode: string;
	fixtures: { id: string; queue: string; jobs: StoredJob[] }[];
}
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: ReturnType<typeof createDataSource>;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;
let server: ReturnType<typeof createServer>;
let origin: string;
const requests: { path: string;
	headers: Record<string, unknown>;
	raw: string;
	body: any }[] = [];

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
	const userId = seeded.actors.ordinary.id;
	const pair = await generateRsaKeyPair();
	await source.getRepository(MiUserKeypair).insert({ userId, publicKey: pair.publicKeyPem, privateKey: pair.privateKeyPem });
	await source.getRepository(MiUserProfile).insert({ userId, userHost: null });
	await source.getRepository(MiMeta).update({ id: 'singleton' }, { federation: 'all' });
	server = createServer(async (req, res) => {
		let raw = '';
		for await (const chunk of req) {
			raw += chunk;
		}
		requests.push({ path: req.url!, headers: req.headers, raw, body: JSON.parse(raw) });
		res.writeHead(204).end();
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	server?.close(); await source?.destroy(); await database?.close(); 
});

function value(): RuntimeConfig {
	const prefix = `handoff-process-${randomUUID()}`;
	return { ...database.config, http: { port: 3000 }, redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` }, processes: { ...database.config.processes, shutdownTimeoutMs: 5000 } };
}

async function oldProduce(config: RuntimeConfig, fixtureIds: string[], bindings: Record<string, unknown> = {}): Promise<Receipt> {
	const directory = await mkdtemp(join(tmpdir(), 'old-handoff-producer-'));
	try {
		const input = join(directory, 'input.json'); const output = join(directory, 'output.json');
		await writeFile(input, JSON.stringify({ redis: config.redisForJobQueue, fixtureIds, bindings }));
		await execute(process.execPath, [generator, upstream, input, output]);
		// Explicit upstream mode executes pinned methods with old installed BullMQ;
		// default mode replays recorded source arguments with the same local version.
		const receipt: Receipt = JSON.parse(await readFile(output, 'utf8'));
		expect(receipt.sourceCommit).toBe('8e07cf085adf7009583d234a208e30436f020e26');
		expect(receipt.bullmqVersion).toBe('6.3.11');
		expect(receipt.mode).toBe(upstream === '--recorded' ? 'recorded-arguments' : 'pinned-source');
		return receipt;
	} finally {
		await rm(directory, { recursive: true, force: true }); 
	}
}

function cli(configPath: string, args = ['--stopped']) {
	const child = spawn(process.execPath, ['built/entrypoints/check-queue-handoff.js', ...args], { env: { ...process.env, MISSKEY_CONFIG_YML: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = ''; child.stdout.on('data', chunk => {
		output += chunk; 
	}); child.stderr.on('data', chunk => {
		output += chunk; 
	});
	const exit = new Promise<number | null>((resolve, reject) => {
		child.once('error', reject); child.once('exit', resolve); 
	});
	return { child, exit, output: () => output };
}

async function control(config: RuntimeConfig) {
	const redis = config.redisForJobQueue;
	const client = new Redis({ host: redis.host, port: redis.port, db: redis.db });
	const queues = new Map<string, Queue>();
	return {
		client,
		queue(name: string) {
			if (!queues.has(name)) {
				queues.set(name, new Queue(name, { ...baseQueueOptions({ ...redis, connectionName: undefined }, name, 5000), skipMetasUpdate: true }));
			} return queues.get(name)!; 
		},
		async snapshot() {
			const keys = (await client.keys('*')).filter(key => key.startsWith(`${redis.prefix}:queue:`)).sort();
			return Promise.all(keys.map(async key => [key, (await client.dumpBuffer(key))!.toString('base64')]));
		},
		async close() {
			for (const queue of queues.values()) {
				await queue.close();
			} const keys = (await client.keys('*')).filter(key => key.startsWith(`${redis.prefix}:queue:`)); if (keys.length) {
				await client.del(...keys);
			} await client.quit(); 
		},
	};
}

test('stopped source fixture jobs retain deliver single/bulk, delayed poll and seven webhook envelopes in the normal worker process', async () => {
	const config = value(); const file = await configuration(config); const inspect = await control(config);
	let worker: ReturnType<typeof launch> | undefined;
	const noteId = seeded.codec.newId(Date.now()); const webhookId = seeded.codec.newId(Date.now()); const userId = seeded.actors.ordinary.id;
	await source.getRepository(MiNote).insert({ id: noteId, userId, hasPoll: true, text: 'old poll', visibility: 'public' });
	await source.getRepository(MiWebhook).insert({ id: webhookId, userId, name: 'old hook', active: true, on: ['note'], url: `${origin}/hook`, secret: 'current-row-secret-differs' });
	const start = requests.length;
	try {
		const receipt = await oldProduce(config, ['deliver-single', 'deliver-bulk', 'poll-future', ...['note', 'reply', 'renote', 'mention', 'follow', 'unfollow', 'followed'].map(type => `webhook-${type}`)], { userId, noteId, webhookId, webhookUrl: `${origin}/hook`, deliverUrl: `${origin}/inbox`, sharedInboxUrl: `${origin}/inbox/shared` });
		const before = await inspect.snapshot(); const check = cli(file.path);
		expect(await check.exit, check.output()).toBe(0); expect(JSON.parse(check.output()).ready).toBe(true); expect(await inspect.snapshot()).toEqual(before);
		expect(await source.query('SELECT recipient_id FROM backend_internal.notification WHERE note_id = $1', [noteId])).toEqual([]);
		const poll = receipt.fixtures.find(fixture => fixture.id === 'poll-future')!.jobs[0];
		expect(await inspect.queue('endedPollNotification').getJob(poll.id)).toMatchObject({ delay: 5000 });
		worker = launch('built/entrypoints/worker.js', file.path); await worker.ready;
		await vi.waitFor(async () => {
			for (const fixture of receipt.fixtures) {
				for (const job of fixture.jobs) {
					expect(await (await inspect.queue(fixture.queue).getJob(job.id))!.getState()).toBe('completed');
				}
			}
		}, { timeout: 20000, interval: 100 });
		const received = requests.slice(start);
		expect(received.filter(request => request.path.startsWith('/inbox'))).toHaveLength(3);
		for (const fixture of receipt.fixtures) {
			for (const original of fixture.jobs) {
				const stored = await inspect.queue(fixture.queue).getJob(original.id);
				expect(stored).toMatchObject({ id: original.id, name: original.name, data: original.data, opts: original.opts, attemptsMade: 1 });
				if (fixture.queue === 'deliver') {
					const delivery = received.find(request => request.path === new URL(original.data.to).pathname)!;
					expect(delivery.raw).toBe(original.data.content); expect(delivery.headers.digest).toBe(original.data.digest); expect(delivery.headers.signature).toEqual(expect.stringContaining(`keyId="${config.url}/users/${userId}#main-key"`));
				}
				if (fixture.queue === 'userWebhookDeliver') {
					const request = received.find(request => request.body.eventId === original.data.eventId && request.body.type === original.data.type)!;
					expect(request.headers['x-misskey-hook-secret']).toBe('fixture-secret');
					expect(request.body).toEqual({ server: config.url, hookId: webhookId, userId, eventId: original.data.eventId, createdAt: original.data.createdAt, type: original.data.type, body: original.data.content });
				}
			}
		}
		expect(received.filter(request => request.path === '/hook')).toHaveLength(7);
		expect(await source.query('SELECT recipient_id,notifier_id FROM backend_internal.notification WHERE notification_type=\'pollEnded\' AND note_id=$1', [noteId])).toEqual([{ recipient_id: userId, notifier_id: null }]);
		await vi.waitFor(async () => expect((await source.getRepository(MiWebhook).findOneByOrFail({ id: webhookId })).latestStatus).toBe(204));
		worker.child.kill('SIGTERM'); expect((await worker.exit).code, worker.output()).toBe(0);
	} finally {
		await worker?.close(); await inspect.close(); await file.close(); 
	}
});

test('old transient retry resumes naturally under the new worker while terminal failed work remains failed', async () => {
	const config = value(); const file = await configuration(config); const inspect = await control(config);
	let worker: ReturnType<typeof launch> | undefined; const directory = await mkdtemp(join(tmpdir(), 'old-state-handoff-'));
	try {
		const bindings = { userId: seeded.actors.ordinary.id, deliverUrl: `${origin}/retry-inbox` };
		const retry = (await oldProduce(config, ['deliver-single'], bindings)).fixtures[0].jobs[0];
		const failed = (await oldProduce(config, ['deliver-single'], bindings)).fixtures[0].jobs[0];
		const input = join(directory, 'old-worker.json'); await writeFile(input, JSON.stringify({ redis: config.redisForJobQueue, terminalId: failed.id }));
		await execute(process.execPath, ['test/fixtures/queue-handoff-old-worker.mjs', upstream, input]);
		const queue = inspect.queue('deliver');
		const retried = (await queue.getJob(retry.id))!; const terminal = (await queue.getJob(failed.id))!;
		expect(await retried.getState()).toBe('delayed'); expect(retried.attemptsMade).toBe(1); expect(retried.delay).toBe(60000);
		expect(await terminal.getState()).toBe('failed'); expect(terminal.attemptsMade).toBe(1);
		const before = await inspect.snapshot(); expect((await inspectQueueHandoff({ redis: config.redisForJobQueue, connectTimeoutMs: 5000 })).ready).toBe(true); expect(await inspect.snapshot()).toEqual(before);
		const requestStart = requests.length; const time = Date.now();
		worker = launch('built/entrypoints/worker.js', file.path); await worker.ready;
		expect(await terminal.getState()).toBe('failed');
		await vi.waitFor(async () => expect(await retried.getState()).toBe('completed'), { timeout: 75000, interval: 200 });
		expect(Date.now() - time).toBeGreaterThan(55000);
		expect(await queue.getJob(retry.id)).toMatchObject({ id: retry.id, name: retry.name, data: retry.data, opts: retry.opts, attemptsMade: 2 });
		expect(await queue.getJob(failed.id)).toMatchObject({ id: failed.id, attemptsMade: 1, failedReason: 'fixture terminal failure' }); expect(await terminal.getState()).toBe('failed');
		expect(requests.slice(requestStart).filter(request => request.path === '/retry-inbox')).toHaveLength(1);
		worker.child.kill('SIGTERM'); expect((await worker.exit).code, worker.output()).toBe(0);
	} finally {
		await worker?.close(); await inspect.close(); await file.close(); await rm(directory, { recursive: true, force: true }); 
	}
}, 100000);

test('built CLI has bounded success, refusal, stopped attestation and connection failure with safe output', async () => {
	const config = value(); const file = await configuration(config); const inspect = await control(config);
	try {
		const empty = cli(file.path); expect(await empty.exit, empty.output()).toBe(0);
		for (const { args, code } of [
			{ args: [], code: 'STOPPED_ATTESTATION_REQUIRED' },
			{ args: ['--stopped', '--secret-invalid'], code: 'INVALID_ARGUMENTS' },
		]) {
			const rejected = cli('/sentinel-secret/missing-config', args);
			expect(await rejected.exit).toBe(1);
			expect(rejected.output()).toBe(`${JSON.stringify({ ready: false, code })}\n`);
			expect(rejected.output()).not.toMatch(/sentinel-secret|secret-invalid/);
		}
		await inspect.queue('deliver').add('sentinel-secret-name', { to: 'https://sentinel-secret.example', secret: 'sentinel-secret' });
		const blocked = cli(file.path); expect(await blocked.exit).toBe(1); expect(blocked.output()).toContain('INVALID_PAYLOAD'); expect(blocked.output()).not.toContain('sentinel-secret');
		const bad = await configuration({ ...config, redisForJobQueue: { ...config.redisForJobQueue, port: await freePort() }, processes: { ...config.processes, startupTimeoutMs: 300 } });
		try {
			const disconnected = cli(bad.path); expect(await disconnected.exit).toBe(1); expect(disconnected.output()).toBe('{"ready":false,"code":"QUEUE_HANDOFF_INSPECTION_FAILED"}\n'); 
		} finally {
			await bad.close(); 
		}
	} finally {
		await inspect.close(); await file.close(); 
	}
});

test('disconnecting an in-flight CLI inspection fails once and releases its named Redis connection', async () => {
	const config = value(); config.redisForJobQueue.connectionName = `handoff-cli-${randomUUID()}`;
	const file = await configuration(config); const inspect = await control(config); let check: ReturnType<typeof cli> | undefined;
	try {
		await inspect.queue('endedPollNotification').addBulk(Array.from({ length: 4000 }, () => ({ name: 'sentinel-secret', data: { noteId: 'sentinel-secret' } })));
		check = cli(file.path);
		let id: string | undefined;
		await vi.waitFor(async () => {
			const list = String(await inspect.client.client('LIST')); id = list.split('\n').find(line => line.includes(`name=${config.redisForJobQueue.connectionName} `))?.match(/^id=(\d+)/)?.[1]; expect(id).toBeDefined(); 
		}, { timeout: 5000, interval: 5 });
		await inspect.client.client('KILL', 'ID', id!);
		expect(await check.exit, check.output()).toBe(1); expect(check.output()).toBe('{"ready":false,"code":"QUEUE_HANDOFF_INSPECTION_FAILED"}\n');
		expect(String(await inspect.client.client('LIST'))).not.toContain(`name=${config.redisForJobQueue.connectionName} `);
	} finally {
		check?.child.kill('SIGKILL'); await inspect.close(); await file.close(); 
	}
});
