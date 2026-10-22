/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type { DataSource } from 'typeorm';
import { BullmqDispatch } from '../../src/platform/jobs/bullmq-dispatch.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { recoverPostWork } from '../../src/platform/database/post-work/recovery.js';
import { PostWorkDispatchStore, scanPostWork } from '../../src/platform/database/post-work/dispatch.js';
import { PostWorkLocalExecutionStore } from '../../src/platform/database/post-work/local-execution.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { createTestDatabase } from '../helpers/database.js';
import { notificationRequest } from '../helpers/post-work.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let store: PostWorkDispatchStore;
let transport: BullmqDispatch;
let queue: Queue;
let otherQueue: Queue;
let prefix: string;
const controls = () => source.query('SELECT queue_key,queue_generation,recovery_pending,reserved_dispatches FROM backend_internal.work_control ORDER BY queue_key');
const business = () => source.query('SELECT state,attempt_count,dispatch_seq,deadline_at,payload_hash FROM backend_internal.work_item ORDER BY work_id');
const append = async (count = 1) => {
	const now = Date.now() - 1000;
	const request = notificationRequest('recovery');
	request.occurredAtMs = now;
	request.notBeforeMs = now;
	request.payload.candidates = Array.from({ length: count }, (_, i) => ({ recipientId: `user${i}`, type: 'mention' }));
	await source.transaction(manager => withPostWorkRequests(manager, requests => requests.append(request)));
};
const connection = () => ({ host: '127.0.0.1', port: database.config.redis.port, maxRetriesPerRequest: null });
const asEnvelope = (value: Awaited<ReturnType<typeof store.pending>>[number]) => ({
	workId: value.workId, kind: value.kind, schemaVersion: value.schemaVersion,
	dispatchSeq: value.dispatchSeq, queueGeneration: value.queueGeneration,
});

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	store = new PostWorkDispatchStore(source);
});
beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.query('UPDATE backend_internal.work_control SET queue_generation=1,recovery_pending=false,reserved_dispatches=0,paused=false');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3,reserved_bytes=6144');
	prefix = `recovery-${randomUUID()}`;
	transport = new BullmqDispatch(connection(), prefix);
	queue = new Queue('postLocal', { connection: connection(), prefix });
	otherQueue = new Queue('deliver', { connection: connection(), prefix });
});
afterEach(async () => {
	await transport.close();
	for (const value of [queue, otherQueue]) {
		await value.obliterate({ force: true });
		await (await value.backend.client).del(`${value.keys.meta}:dispatch-generation`);
		await value.close();
	}
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('fresh startup advances both queues once and concurrent healthy starters join that generation', async () => {
	const results = await Promise.all(Array.from({ length: 4 }, () => recoverPostWork(source, transport)));
	expect(results).toEqual(Array(4).fill({ deliver: '2', postLocal: '2' }));
	expect(await controls()).toEqual([
		{ queue_key: 'deliver', queue_generation: '2', recovery_pending: false, reserved_dispatches: 0 },
		{ queue_key: 'postLocal', queue_generation: '2', recovery_pending: false, reserved_dispatches: 0 },
	]);
});

test('pending recovery fences dispatch and local execution without changing durable business progress', async () => {
	await append();
	await transport.initialize('postLocal', '1');
	await scanPostWork(store, transport, 'scanner');
	const [saved] = await store.pending();
	await source.query('UPDATE backend_internal.work_control SET recovery_pending=true');
	const before = await business();
	expect(await new PostWorkLocalExecutionStore(source).claim(asEnvelope(saved), 'worker')).toBe(null);
	await source.query("UPDATE backend_internal.work_item SET last_enqueued_at=NULL");
	expect((await store.claim('scanner')).status).toBe('waiting');
	expect(await business()).toEqual(before);
	expect((await store.pending())).toHaveLength(1);
});

test('lost queue namespace releases old reservations once, rejects delayed enqueue and allows a new sequence', async () => {
	await recoverPostWork(source, transport);
	await append();
	await scanPostWork(store, transport, 'scanner');
	const [old] = await store.pending();
	const before = await business();
	const charges = await source.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity');
	await queue.obliterate({ force: true });
	await (await queue.backend.client).del(`${queue.keys.meta}:dispatch-generation`);

	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '3', postLocal: '3' });
	expect(await store.pending()).toHaveLength(0);
	expect(await business()).toEqual(before);
	expect(await source.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity')).toEqual(charges);
	await expect(transport.enqueue(old, Date.now())).rejects.toThrow(/generation/);
	await expect(recoverPostWork(source, transport)).resolves.toEqual({ deliver: '3', postLocal: '3' });
	await source.query('UPDATE backend_internal.work_item SET last_enqueued_at=NULL');
	await scanPostWork(store, transport, 'scanner');
	const [next] = await store.pending();
	expect(next.workId).toBe(old.workId);
	expect(next.dispatchSeq).toBe('2');
	expect(next.queueGeneration).toBe('3');
	expect(await queue.getWaitingCount()).toBe(1);
});

test('partial gate initialization resumes the committed pending generation and blocks all claims', async () => {
	await append();
	let fail = true;
	const broken = {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: async (...args: Parameters<BullmqDispatch['replaceGeneration']>) => {
			if (args[0] === 'postLocal' && fail) {
				fail = false;
				throw new Error('gate response lost');
			}
			await transport.replaceGeneration(...args);
		},
		retire: transport.retire.bind(transport),
	};
	await expect(recoverPostWork(source, broken)).rejects.toThrow('gate response lost');
	expect((await controls()).every((value: { recovery_pending: boolean }) => value.recovery_pending)).toBe(true);
	expect((await store.claim('scanner')).status).toBe('waiting');
	expect(await transport.readGeneration('deliver')).toBe('2');
	expect(await transport.readGeneration('postLocal')).toBe(null);
	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '2', postLocal: '2' });
});

test('gate initialization acknowledgement loss is resumed without another generation increment', async () => {
	const broken = {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: async (...args: Parameters<BullmqDispatch['replaceGeneration']>) => {
			await transport.replaceGeneration(...args);
			throw new Error('after Redis commit');
		},
		retire: transport.retire.bind(transport),
	};
	await expect(recoverPostWork(source, broken)).rejects.toThrow('after Redis commit');
	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '2', postLocal: '2' });
});

test('reconciles more than one hundred unexpired old entries before clearing pending', async () => {
	await transport.initialize('postLocal', '1');
	await append(101);
	await scanPostWork(store, transport, 'scanner');
	await scanPostWork(store, transport, 'scanner');
	expect(await queue.getWaitingCount()).toBe(101);
	let retired = 0;
	const checked = {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: transport.replaceGeneration.bind(transport),
		retire: async (value: Parameters<BullmqDispatch['retire']>[0]) => {
			expect((await controls()).every((row: { recovery_pending: boolean }) => row.recovery_pending)).toBe(true);
			retired++;
			return transport.retire(value);
		},
	};
	await recoverPostWork(source, checked);
	expect(retired).toBe(101);
	expect(await queue.getWaitingCount()).toBe(0);
	expect(await store.pending()).toHaveLength(0);
	expect((await controls()).every((row: { reserved_dispatches: number }) => row.reserved_dispatches === 0)).toBe(true);
});

test('active old entry fails startup and retains capacity until it finishes', async () => {
	await transport.initialize('postLocal', '1');
	await append();
	let finish!: () => void;
	const running = new Promise<void>(resolve => {
		finish = resolve;
	});
	const worker = new Worker('postLocal', async () => running, { connection: connection(), prefix });
	try {
		await scanPostWork(store, transport, 'scanner');
		await expect.poll(() => queue.getActiveCount()).toBe(1);
		await expect(recoverPostWork(source, transport)).rejects.toThrow(/active/);
		expect(await store.pending()).toHaveLength(1);
		expect((await controls())[1]).toMatchObject({ recovery_pending: true, reserved_dispatches: 1, queue_generation: '2' });
		finish();
		await expect.poll(() => queue.getCompletedCount()).toBe(1);
		expect(await recoverPostWork(source, transport)).toEqual({ deliver: '2', postLocal: '2' });
		expect(await store.pending()).toHaveLength(0);
	} finally {
		finish();
		await worker.close();
	}
});

test('retirement response loss preserves the reservation for a confirmed restart', async () => {
	await transport.initialize('postLocal', '1');
	await append();
	await scanPostWork(store, transport, 'scanner');
	await expect(recoverPostWork(source, {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: transport.replaceGeneration.bind(transport),
		retire: async value => {
			await transport.retire(value);
			throw new Error('retire response lost');
		},
	})).rejects.toThrow('retire response lost');
	expect(await store.pending()).toHaveLength(1);
	expect((await controls())[1].reserved_dispatches).toBe(1);
	await recoverPostWork(source, transport);
	expect((await controls())[1].reserved_dispatches).toBe(0);
});

test('future or invalid Redis generation fails without changing DB state', async () => {
	await transport.initialize('deliver', '9');
	await expect(recoverPostWork(source, transport)).rejects.toThrow(/generation/);
	expect((await controls()).every((row: { queue_generation: string; recovery_pending: boolean }) => row.queue_generation === '1' && !row.recovery_pending)).toBe(true);
	await (await otherQueue.backend.client).set(`${otherQueue.keys.meta}:dispatch-generation`, 'invalid');
	await expect(recoverPostWork(source, transport)).rejects.toThrow(/generation/);
});

test('generation CAS rejects an unexpected gate and preserves exact bigint strings', async () => {
	const big = '9007199254740993';
	await source.query('UPDATE backend_internal.work_control SET queue_generation=$1', [big]);
	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '9007199254740994', postLocal: '9007199254740994' });
	await expect(transport.replaceGeneration('deliver', big, '9007199254740995')).rejects.toThrow(/generation/);
	expect(await transport.readGeneration('deliver')).toBe('9007199254740994');
});

test('recovery migration has a reversible schema and preserves control counters', async () => {
	await assertSchemaMatches(database.config.database);
	const migrations = migrationSources(database.config.database).internal;
	await migrations.initialize();
	try {
		await source.query("UPDATE backend_internal.work_control SET queue_generation=7,paused=true,reserved_dispatches=3");
		await migrations.undoLastMigration();
		expect(await source.query('SELECT queue_generation,paused,reserved_dispatches FROM backend_internal.work_control')).toEqual(Array(2).fill({ queue_generation: '7', paused: true, reserved_dispatches: 3 }));
		await migrations.runMigrations();
		expect((await controls()).every((row: { recovery_pending: boolean }) => !row.recovery_pending)).toBe(true);
	} finally {
		await migrations.destroy();
	}
	await assertSchemaMatches(database.config.database);
});

test('stop after DB commit and before either Redis gate resumes the same generation', async () => {
	await expect(recoverPostWork(source, {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: async () => {
			throw new Error('stopped before Redis');
		},
		retire: transport.retire.bind(transport),
	})).rejects.toThrow('stopped before Redis');
	expect((await controls()).every((row: { queue_generation: string; recovery_pending: boolean }) => row.queue_generation === '2' && row.recovery_pending)).toBe(true);
	expect(await transport.readGeneration('deliver')).toBe(null);
	expect(await transport.readGeneration('postLocal')).toBe(null);
	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '2', postLocal: '2' });
});

test('gate loss during reconciliation leaves recovery pending for a safe restart', async () => {
	await transport.initialize('postLocal', '1');
	await append();
	await scanPostWork(store, transport, 'scanner');
	await expect(recoverPostWork(source, {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: transport.replaceGeneration.bind(transport),
		retire: async value => {
			const result = await transport.retire(value);
			await (await queue.backend.client).del(`${queue.keys.meta}:dispatch-generation`);
			return result;
		},
	})).rejects.toThrow(/generation changed/);
	expect((await controls())[1]).toMatchObject({ queue_generation: '2', recovery_pending: true, reserved_dispatches: 0 });
	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '2', postLocal: '2' });
});

test('lost coordinator DB connection cannot clear pending and its session lock is released', async () => {
	await expect(recoverPostWork(source, {
		readGeneration: transport.readGeneration.bind(transport),
		replaceGeneration: async (...args: Parameters<BullmqDispatch['replaceGeneration']>) => {
			if (args[0] === 'deliver') {
				const killed = await source.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_locks WHERE locktype='advisory' AND classid=1792665615 AND objid=537 AND granted");
				expect(killed).toEqual([{ killed: true }]);
			}
			await transport.replaceGeneration(...args);
		},
		retire: transport.retire.bind(transport),
	})).rejects.toThrow();
	expect((await controls()).every((row: { recovery_pending: boolean }) => row.recovery_pending)).toBe(true);
	expect(await recoverPostWork(source, transport)).toEqual({ deliver: '2', postLocal: '2' });
});
