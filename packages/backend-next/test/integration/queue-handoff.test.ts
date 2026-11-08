/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { expect, test } from 'vitest';
import { QUEUE_NAMES } from '../../src/modules/queue/public.js';
import { baseQueueOptions } from '../../src/platform/job-queue/connection.js';
import { inspectQueueHandoff } from '../../src/platform/job-queue/handoff.js';
import { testConfig } from '../helpers/database.js';

const execute = promisify(execFile);
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH ?? '--recorded';

async function fixture() {
	const redis = { ...testConfig().redisForJobQueue, prefix: `handoff-[x]?*\\-${randomUUID()}`, keyPrefix: 'must-be-stripped:' };
	const client = new Redis({ host: redis.host, port: redis.port, db: redis.db });
	const queues: Queue[] = [];
	return {
		redis, client,
		queue(name: string, prefix = redis.prefix) {
			const queue = new Queue(name, { ...baseQueueOptions({ ...redis, prefix }, name, 5000), skipMetasUpdate: true });
			queues.push(queue);
			return queue;
		},
		async inspect() {
			return inspectQueueHandoff({ redis, connectTimeoutMs: 5000 }); 
		},
		// DUMP compares encoded Redis values independently of the inspector, including zset scores.
		async snapshot() {
			const keys = (await client.keys('*')).filter(key => key.startsWith(redis.prefix)).sort();
			return Promise.all(keys.map(async key => [key, (await client.dumpBuffer(key))!.toString('base64')]));
		},
		async close() {
			for (const queue of queues) {
				await queue.close();
			}
			const keys = (await client.keys('*')).filter(key => key.startsWith(redis.prefix));
			if (keys.length) {
				await client.del(...keys);
			}
			await client.quit();
		},
	};
}

async function unchanged(f: Awaited<ReturnType<typeof fixture>>, ready: boolean) {
	const before = await f.snapshot();
	const report = await f.inspect();
	expect(report.ready, JSON.stringify(report)).toBe(ready);
	expect(await f.snapshot()).toEqual(before);
	return report;
}

test('empty job Redis is not initialized, even with glob characters, adjacent prefix and other DB', async () => {
	const f = await fixture();
	const otherDb = new Redis({ host: f.redis.host, port: f.redis.port, db: 1 });
	try {
		const neighbor = f.queue('system', `${f.redis.prefix}-neighbor`);
		await neighbor.add('secret-name', { secret: 'sentinel-secret' });
		await otherDb.set(`${f.redis.prefix}:queue:system:system:unknown`, 'sentinel-secret');
		await f.client.set(`${f.redis.prefix}:kvcache:ordinary`, 'ordinary');
		const report = await unchanged(f, true);
		expect(report.queues).toHaveLength(10);
		expect(report.queues.every(queue => Object.values(queue.counts).every(count => count === 0))).toBe(true);
		expect(await otherDb.get(`${f.redis.prefix}:queue:system:system:unknown`)).toBe('sentinel-secret');
	} finally {
		await otherDb.del(`${f.redis.prefix}:queue:system:system:unknown`); await otherDb.quit(); await f.close();
	}
});

test('fixed source fixture arguments create real BullMQ jobs; the full census preserves their wire records', async () => {
	const f = await fixture();
	const directory = await mkdtemp(join(tmpdir(), 'old-queue-handoff-'));
	try {
		const input = join(directory, 'input.json'); const output = join(directory, 'receipt.json');
		await writeFile(input, JSON.stringify({ redis: f.redis, fixtureIds: ['deliver-single', 'deliver-bulk', 'poll-future', 'webhook-note', 'webhook-follow', 'webhook-followed'] }));
		await execute(process.execPath, [resolve('../../docs/superpowers/compatibility/queue-handoff/generate-bullmq.cjs'), upstream, input, output]);
		const receipt = JSON.parse(await readFile(output, 'utf8'));
		expect(receipt.sourceCommit).toBe('8e07cf085adf7009583d234a208e30436f020e26');
		expect(receipt.bullmqVersion).toBe('6.3.11');
		expect(receipt.mode).toBe(upstream === '--recorded' ? 'recorded-arguments' : 'pinned-source');
		expect(receipt.fixtures).toHaveLength(6);
		const report = await unchanged(f, true);
		expect(report.queues.find(q => q.queue === 'deliver')!.counts.wait).toBe(3);
		expect(report.queues.find(q => q.queue === 'endedPollNotification')!.counts.delayed).toBe(1);
		expect(report.queues.find(q => q.queue === 'userWebhookDeliver')!.counts.wait).toBe(3);
		expect(JSON.stringify(report)).not.toMatch(/fixture-secret|hook\.example|remote\.example/);
	} finally {
		await rm(directory, { recursive: true, force: true }); await f.close(); 
	}
});

test('paging finds an incompatible job after 400 compatible paused jobs', async () => {
	const f = await fixture();
	try {
		const queue = f.queue('endedPollNotification'); await queue.pause();
		await queue.addBulk(Array.from({ length: 401 }, (_, i) => ({ name: 'note', data: i === 400 ? { workId: 'removed-durable-format' } : { noteId: `note-${i}` } })));
		const report = await unchanged(f, false);
		expect(report.queues.find(q => q.queue === 'endedPollNotification')).toMatchObject({ paused: true, counts: { wait: 401 }, blockers: [{ code: 'INVALID_PAYLOAD', count: 1 }] });
	} finally {
		await f.close(); 
	}
});

test.each(QUEUE_NAMES.filter(name => !['deliver', 'endedPollNotification', 'userWebhookDeliver'].includes(name)))('%s refuses unfinished and failed work but retains completed-only history', async name => {
	const f = await fixture();
	try {
		const queue = f.queue(name);
		const job = await queue.add('retained', { noteId: 'note' });
		await unchanged(f, false);
		// Fixture transitions use real BullMQ. There is deliberately no placeholder product handler.
		const worker = new Worker(name, async () => {}, { ...baseQueueOptions(f.redis, name, 5000), autorun: false });
		const claimed = await worker.getNextJob('fixture-token');
		expect(claimed!.id).toBe(job.id);
		await claimed!.moveToCompleted(undefined, 'fixture-token', false); await worker.close();
		await unchanged(f, true);
		await f.client.zrem(queue.toKey('completed'), job.id!); await f.client.zadd(queue.toKey('failed'), Date.now(), job.id!);
		await unchanged(f, false);
	} finally {
		await f.close(); 
	}
});

test.each(['lock', 'orphan', 'repeat-metadata', 'legacy-repeat', 'waiting-children', 'dependency', 'unknown-queue'])('%s evidence is refused without recovery or mutation', async kind => {
	const f = await fixture();
	try {
		const queue = f.queue('endedPollNotification');
		const root = queue.qualifiedName;
		if (kind === 'lock') {
			await f.client.set(`${root}:orphan:lock`, 'secret-lock-token');
		}
		if (kind === 'orphan') {
			await f.client.hset(`${root}:orphan`, { name: 'name-secret', data: '{"noteId":"secret"}', opts: '{}' });
		}
		if (kind === 'repeat-metadata') {
			await f.client.hset(`${root}:repeat:secret-scheduler`, { name: 'secret' });
		}
		if (kind === 'legacy-repeat') {
			await f.client.zadd(`${root}:repeat`, Date.now(), 'name:id:end:tz:pattern');
		}
		if (kind === 'waiting-children') {
			const job = await queue.add('note', { noteId: 'note' }); await f.client.lrem(`${root}:wait`, 0, job.id!); await f.client.zadd(`${root}:waiting-children`, Date.now(), job.id!); 
		}
		if (kind === 'dependency') {
			await f.client.sadd(`${root}:orphan:dependencies`, 'secret-key');
		}
		if (kind === 'unknown-queue') {
			await f.client.set(`${f.redis.prefix}:queue:secret-queue:secret-queue:meta`, 'secret');
		}
		const report = await unchanged(f, false);
		expect(JSON.stringify(report)).not.toMatch(/secret|orphan|pattern/);
	} finally {
		await f.close(); 
	}
});

test('actual source system scheduler and delayed occurrence remain a blocker with zero waiting jobs', async () => {
	const f = await fixture(); const directory = await mkdtemp(join(tmpdir(), 'old-scheduler-handoff-'));
	try {
		const input = join(directory, 'input.json'); const output = join(directory, 'receipt.json');
		await writeFile(input, JSON.stringify({ redis: f.redis, fixtureIds: [], schedulerIds: ['clean'] }));
		await execute(process.execPath, [resolve('../../docs/superpowers/compatibility/queue-handoff/generate-bullmq.cjs'), upstream, input, output]);
		const report = await unchanged(f, false);
		expect(report.queues.find(q => q.queue === 'system')).toMatchObject({ counts: { wait: 0, delayed: 1, repeat: 1 } });
	} finally {
		await rm(directory, { recursive: true, force: true }); await f.close(); 
	}
});

test('real old jobs for all seven missing handlers, including delayed drafts and relationships, remain blocked and intact', async () => {
	const f = await fixture();
	const directory = await mkdtemp(join(tmpdir(), 'old-unsupported-handoff-'));
	try {
		const input = join(directory, 'input.json');
		const output = join(directory, 'receipt.json');
		await writeFile(input, JSON.stringify({ redis: f.redis, fixtureIds: ['inbox', 'system-archive', 'db-import', 'relationship-delayed', 'object-storage', 'system-webhook', 'scheduled-note'] }));
		await execute(process.execPath, [resolve('../../docs/superpowers/compatibility/queue-handoff/generate-bullmq.cjs'), upstream, input, output]);
		const report = await unchanged(f, false);
		expect(report.queues.filter(queue => queue.blockers.some(blocker => blocker.code === 'UNSUPPORTED_QUEUE'))).toHaveLength(7);
		for (const name of ['system', 'relationship', 'postScheduledNote']) {
			expect(report.queues.find(queue => queue.queue === name)!.counts.delayed).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
		await f.close();
	}
});

test('active work is refused with or without its lock; a wrong Redis type fails closed', async () => {
	const f = await fixture(); let worker: Worker | undefined;
	try {
		const queue = f.queue('endedPollNotification'); await queue.add('note', { noteId: 'note' });
		worker = new Worker(queue.name, async () => {}, { ...baseQueueOptions(f.redis, queue.name, 5000), autorun: false });
		const job = await worker.getNextJob('secret-lock-token');
		await unchanged(f, false); await f.client.del(queue.toKey(`${job!.id}:lock`)); await unchanged(f, false);
		await f.client.set(queue.toKey('delayed'), 'sentinel-secret');
		const before = await f.snapshot();
		await expect(f.inspect()).rejects.toThrow('QUEUE_HANDOFF_INSPECTION_FAILED');
		expect(await f.snapshot()).toEqual(before);
	} finally {
		await worker?.close(); await f.close(); 
	}
});

test.each(['marker', 'events', 'id', 'pc', 'stalled-check', 'limiter', 'metrics:completed', 'metrics:failed:data', 'job-logs'])('wrong-type %s metadata is refused without modifying its encoded value', async suffix => {
	const f = await fixture();
	try {
		const queue = f.queue('endedPollNotification');
		const job = await queue.add('note', { noteId: 'note' });
		const key = queue.toKey(suffix === 'job-logs' ? `${job.id}:logs` : suffix);
		await f.client.del(key);
		if (['id', 'pc', 'stalled-check', 'limiter'].includes(suffix)) {
			await f.client.hset(key, 'sentinel-secret', 'sentinel-secret');
		} else {
			await f.client.set(key, 'sentinel-secret');
		}
		const report = await unchanged(f, false);
		expect(JSON.stringify(report)).not.toContain('sentinel-secret');
		expect(report.queues.find(item => item.queue === 'endedPollNotification')!.blockers).toContainEqual({ code: 'UNKNOWN_RECORD', count: 1 });
	} finally {
		await f.close();
	}
});
