/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { BullmqDispatch } from '../../src/platform/jobs/bullmq-dispatch.js';
import type { DispatchReservation } from '../../src/platform/jobs/dispatch.js';
import { testConfig } from '../helpers/database.js';

const connection = { host: '127.0.0.1', port: testConfig().redis.port, maxRetriesPerRequest: null };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) {
		await close();
	}
	cleanup.length = 0;
});

async function setup() {
	const prefix = `dispatch-${randomUUID()}`;
	const transport = new BullmqDispatch(connection, prefix);
	const queue = new Queue('deliver', { connection, prefix });
	const redis = new Redis(connection);
	cleanup.push(async () => {
		await queue.obliterate({ force: true });
		await queue.close();
		await redis.quit();
	});
	cleanup.push(() => transport.close());
	await transport.initialize('deliver', '1');
	const now = Date.now();
	const reservation: DispatchReservation = {
		workId: 'work', kind: 'ap.send', schemaVersion: 1, dispatchSeq: '1', queueKey: 'deliver',
		queueGeneration: '1', token: randomUUID(), reservedAtMs: now, tokenExpiresAtMs: now + 60000,
	};
	return { transport, queue, redis, prefix, reservation };
}

test('real BullMQ consumes ID-only data and duplicate enqueue preserves one stable job', async () => {
	const { transport, queue, prefix, reservation } = await setup();
	await transport.enqueue(reservation, Date.now());
	await transport.enqueue(reservation, Date.now());
	expect(await queue.getWaitingCount()).toBe(1);
	const received: unknown[] = [];
	const worker = new Worker('deliver', async job => {
		received.push(job.data);
	}, { connection, prefix });
	cleanup.push(() => worker.close());
	await expect.poll(() => received.length).toBe(1);
	expect(received).toEqual([{
		workId: 'work', kind: 'ap.send', schemaVersion: 1, dispatchSeq: '1', queueGeneration: '1',
	}]);
});

test('retirement before delayed enqueue prevents recreation, even before the first add', async () => {
	const { transport, queue, reservation } = await setup();
	expect(await transport.retire(reservation)).toBe(true);
	await expect(transport.enqueue(reservation, Date.now())).rejects.toThrow(/retired/);
	expect(await queue.getWaitingCount()).toBe(0);
});

test('expiration rejects a missing token and does not extend the original absolute deadline', async () => {
	const { transport, queue, reservation } = await setup();
	reservation.reservedAtMs -= 61000;
	reservation.tokenExpiresAtMs -= 61000;
	await expect(transport.enqueue(reservation, Date.now())).rejects.toThrow(/expired/);
	expect(await queue.getWaitingCount()).toBe(0);
});

test('generation mismatch, missing gate and DB/Redis clock skew fail closed', async () => {
	const { transport, queue, reservation } = await setup();
	await expect(transport.enqueue({ ...reservation, queueGeneration: '2' }, Date.now())).rejects.toThrow(/generation/);
	await expect(transport.enqueue({ ...reservation, queueKey: 'postLocal' }, Date.now())).rejects.toThrow(/generation/);
	await expect(transport.enqueue(reservation, Date.now() - 10000)).rejects.toThrow(/clock/);
	expect(await queue.getWaitingCount()).toBe(0);
});

test('cannot release an active entry; terminal retirement is repeatable and fences retries', async () => {
	const { transport, queue, prefix, reservation } = await setup();
	let finish!: () => void;
	const running = new Promise<void>(resolve => {
		finish = resolve;
	});
	const worker = new Worker('deliver', async () => running, { connection, prefix });
	cleanup.push(async () => {
		finish();
		await worker.close();
	});
	await transport.enqueue(reservation, Date.now());
	await expect.poll(() => queue.getActiveCount()).toBe(1);
	expect(await transport.retire(reservation)).toBe(false);
	finish();
	await expect.poll(() => queue.getCompletedCount()).toBe(1);
	expect(await transport.retire(reservation)).toBe(true);
	expect(await transport.retire(reservation)).toBe(true);
	await expect(transport.enqueue(reservation, Date.now())).rejects.toThrow(/retired/);
});

test('retirement removes a waiting entry before confirming it can release capacity', async () => {
	const { transport, queue, reservation } = await setup();
	await transport.enqueue(reservation, Date.now());
	expect(await transport.retire(reservation)).toBe(true);
	expect(await queue.getWaitingCount()).toBe(0);
	await expect(transport.enqueue(reservation, Date.now())).rejects.toThrow(/retired/);
});
