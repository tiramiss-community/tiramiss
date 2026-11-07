/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MiUserProfile } from 'backend-upstream/entities';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { ENDED_POLL_NOTIFICATION } from '../../src/platform/job-queue/ended-poll-notification.js';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { seedRoleHttp } from '../helpers/role-http.js';
import type { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../../src/config/types.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let seeded: Awaited<ReturnType<typeof seedRoleHttp>>;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	seeded = await seedRoleHttp(source);
	await source.getRepository(MiUserProfile).insert({ userId: seeded.actors.ordinary.id, userHost: null });
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

// 試験ごとに queue の prefix を分け、他の試験が残したジョブを取得しない。
function processConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	const prefix = `poll-ended-process-${randomUUID()}`;
	return {
		...database.config,
		redisForJobQueue: { ...database.config.redisForJobQueue, prefix, keyPrefix: `${prefix}:` },
		...overrides,
	};
}

function inspect(config: RuntimeConfig) {
	return new Queue(ENDED_POLL_NOTIFICATION, baseQueueOptions(config.redisForJobQueue, ENDED_POLL_NOTIFICATION, 5000));
}

function pollEndedFor(noteId: string) {
	return source.query("SELECT recipient_id, notifier_id FROM backend_internal.notification WHERE notification_type = 'pollEnded' AND note_id = $1", [noteId]);
}

function waitForMessage(child: ReturnType<typeof launch>, type: string) {
	return new Promise<void>(resolve => {
		child.child.on('message', (message: unknown) => {
			if (message && typeof message === 'object' && 'type' in message && message.type === type) {
				resolve();
			}
		});
	});
}

async function createPollNote(port: number, expiredAfter: number): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/api/notes/create`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ i: seeded.actors.ordinary.token, text: 'poll', poll: { choices: ['a', 'b'], expiredAfter } }),
	});
	expect(response.status).toBe(200);
	return (await response.json() as { createdNote: { id: string } }).createdNote.id;
}

test('a poll created over HTTP is notified to its author by the worker process after the deadline', async () => {
	const port = await freePort();
	const value = processConfig({ http: { port } });
	const config = await configuration(value);
	const http = launch('built/entrypoints/http.js', config.path);
	const worker = launch('built/entrypoints/worker.js', config.path);
	try {
		await Promise.all([http.ready, worker.ready]);
		const noteId = await createPollNote(port, 1500);
		expect(await pollEndedFor(noteId)).toEqual([]);
		await vi.waitFor(async () => {
			expect(await pollEndedFor(noteId)).toEqual([{ recipient_id: seeded.actors.ordinary.id, notifier_id: null }]);
		}, { timeout: 10000, interval: 100 });

		http.child.kill('SIGTERM');
		worker.child.kill('SIGTERM');
		expect((await http.exit).code, http.output()).toBe(0);
		expect((await worker.exit).code, worker.output()).toBe(0);
		expect(http.output()).not.toContain('note-post-save.failed');
		expect(worker.output()).not.toContain('job.failed');
	} finally {
		await http.close();
		await worker.close();
		await config.close();
	}
});

test('a delayed job pending while the worker is stopped runs after a new worker starts', async () => {
	const port = await freePort();
	const value = processConfig({ http: { port } });
	const config = await configuration(value);
	const http = launch('built/entrypoints/http.js', config.path);
	const first = launch('built/entrypoints/worker.js', config.path);
	let second: ReturnType<typeof launch> | undefined;
	const queue = inspect(value);
	try {
		await Promise.all([http.ready, first.ready]);
		const noteId = await createPollNote(port, 1500);
		await vi.waitFor(async () => {
			expect(await queue.getJobCounts('delayed')).toEqual({ delayed: 1 });
		}, { timeout: 5000, interval: 50 });
		first.child.kill('SIGTERM');
		expect((await first.exit).code, first.output()).toBe(0);

		// 停止中に期限を過ぎても、ジョブは失われず次の worker が実行する。
		await new Promise(resolve => setTimeout(resolve, 2000));
		expect(await pollEndedFor(noteId)).toEqual([]);
		second = launch('built/entrypoints/worker.js', config.path);
		await second.ready;
		await vi.waitFor(async () => {
			expect(await pollEndedFor(noteId)).toEqual([{ recipient_id: seeded.actors.ordinary.id, notifier_id: null }]);
		}, { timeout: 10000, interval: 100 });
		// 通知のDB commit 後も publish と BullMQ の完了記録が続く。
		await vi.waitFor(async () => {
			expect(await queue.getJobCounts('completed', 'failed')).toEqual({ completed: 1, failed: 0 });
		}, { timeout: 10000, interval: 100 });
	} finally {
		await queue.close();
		await http.close();
		await first.close();
		await second?.close();
		await config.close();
	}
});

test.each([false, true])('SIGTERM waits for a running job within the shutdown deadline (force=%s)', async force => {
	const value = processConfig({ http: { port: await freePort() }, processes: { ...database.config.processes, shutdownTimeoutMs: force ? 200 : 5000 } });
	const config = await configuration(value);
	const worker = launch('test/fixtures/slow-worker.mjs', config.path, { FIXTURE_JOB_MS: force ? '10000' : '1000' });
	const queue = inspect(value);
	try {
		await worker.ready;
		const started = waitForMessage(worker, 'job-started');
		await queue.add('note', { noteId: 'note' });
		await started;
		worker.child.kill('SIGTERM');

		expect((await worker.exit).code, worker.output()).toBe(force ? 1 : 0);
		const completed = worker.messages.some(message => message && typeof message === 'object' && 'type' in message && message.type === 'job-completed');
		expect(completed).toBe(!force);
		// 期限内に終えたジョブは完了として記録される。期限切れで止めたジョブは実行中のまま残り、BullMQ の stalled 検査で戻る。
		expect(await queue.getJobCounts('completed', 'active')).toEqual(force ? { completed: 0, active: 1 } : { completed: 1, active: 0 });
	} finally {
		await queue.obliterate({ force: true });
		await queue.close();
		await worker.close();
		await config.close();
	}
});

test('losing the poll-ended queue connection of a worker stops the whole process tree abnormally', async () => {
	const value = processConfig({ http: { port: await freePort() } });
	const config = await configuration(value);
	const control = new Redis(database.config.redis);
	const supervisor = launch('built/entrypoints/supervisor.js', config.path);
	let children: { role: string; pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((message: any) => message.role === 'supervisor') as { children: typeof children }).children;
		let blocking: string | undefined;
		await vi.waitFor(async () => {
			blocking = String(await control.client('LIST')).split('\n')
				.find(line => line.includes(`name=${value.redisForJobQueue.prefix}:queue:endedPollNotification:`) && line.includes('cmd=bzpopmin'));
			expect(blocking).toBeDefined();
		}, { timeout: 5000, interval: 50 });
		await control.client('KILL', 'ID', blocking!.match(/^id=(\d+)/)![1]);

		expect((await supervisor.exit).code, supervisor.output()).toBe(1);
		expect(supervisor.output()).toContain('JOB_QUEUE_REDIS_ENDED');
		expect(supervisor.output()).toContain('"queue":"endedPollNotification"');
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		control.disconnect();
		await supervisor.close();
		for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
		await config.close();
	}
});
