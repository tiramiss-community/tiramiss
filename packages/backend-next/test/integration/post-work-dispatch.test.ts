/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { BullmqDispatch } from '../../src/platform/jobs/bullmq-dispatch.js';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateTestDatabase as migrateDatabase } from '../helpers/database.js';
import { PostWorkDispatchStore, scanPostWork, reconcilePostWork } from '../../src/platform/database/post-work/dispatch.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { createTestDatabase, seedHealthyCapacity } from '../helpers/database.js';
import { apRequest, notificationRequest } from '../helpers/post-work.js';
import type { PostWorkRequest } from '../../src/modules/post-work/public.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let store: PostWorkDispatchStore;
const append = async (request: PostWorkRequest) => {
	const now = Date.now() - 1000;
	await source.transaction(manager => withPostWorkRequests(manager, work => work.append({ ...request, occurredAtMs: now, notBeforeMs: now })));
};
const appendSend = async (request = apRequest()) => {
	await append(request);
	// Seed the send item that J2b will normally create from a fixed recipient.
	await source.query("UPDATE backend_internal.work_item SET kind='ap.send' WHERE request_id=$1", [request.requestId]);
};
const items = () => source.query('SELECT state, attempt_count, dispatch_seq::int AS seq FROM backend_internal.work_item ORDER BY request_id');

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	store = new PostWorkDispatchStore(source);
});
beforeEach(async () => {
	await seedHealthyCapacity(source);
	await source.query('TRUNCATE backend_internal.ap_host_lease, backend_internal.delivery_recipient, backend_internal.notification, backend_internal.notification_effect, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.query('UPDATE backend_internal.work_control SET reserved_dispatches=0, paused=false');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3, reserved_bytes=6144');
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('concurrent scanners claim once and dispatch never consumes execution attempts', async () => {
	await appendSend();
	const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.claim(`scanner${i}`)));
	expect(results.filter(result => result.status === 'claimed')).toHaveLength(1);
	expect(await items()).toEqual([{ state: 'ready', attempt_count: 0, seq: 1 }]);
	expect((await source.query('SELECT reserved_dispatches FROM backend_internal.work_control WHERE queue_key=\'deliver\''))[0].reserved_dispatches).toBe(1);
});

test.each(['reserved', 'enqueue_unknown'])('keeps a live %s reservation after its dispatch claim expires', async state => {
	await appendSend();
	const first = await store.claim('same');
	if (first.status !== 'claimed') {
		throw new Error('missing first claim');
	}
	await source.query("UPDATE backend_internal.work_item SET dispatch_until=clock_timestamp()-interval '1 second'");
	await source.query('UPDATE backend_internal.queue_dispatch SET state=$1', [state]);
	const before = await source.query('SELECT reserved_rows, reserved_bytes FROM backend_internal.work_capacity');

	expect((await store.claim('same')).status).toBe('empty');
	expect(await store.pending()).toEqual([first.reservation]);
	expect(await items()).toEqual([{ state: 'ready', attempt_count: 0, seq: 1 }]);
	expect(await source.query('SELECT reserved_rows, reserved_bytes FROM backend_internal.work_capacity')).toEqual(before);
	expect((await source.query("SELECT reserved_dispatches FROM backend_internal.work_control WHERE queue_key='deliver'"))[0].reserved_dispatches).toBe(1);

	await append(notificationRequest('other'));
	const other = await store.claim('another');
	expect(other.status).toBe('claimed');
	if (other.status === 'claimed') {
		expect(other.reservation.queueKey).toBe('postLocal');
	}

	await source.query("UPDATE backend_internal.queue_dispatch SET reserved_at=reserved_at-interval '61 seconds', token_expires_at=token_expires_at-interval '61 seconds' WHERE work_id=$1", [first.reservation.workId]);
	const second = await store.claim('same');
	if (second.status !== 'claimed') {
		throw new Error('missing claim after token expiry');
	}
	expect(second.reservation.workId).toBe(first.reservation.workId);
	expect(second.reservation.dispatchSeq).toBe('2');
});

test('full queue waits without consuming a seq and the scanner continues into another queue', async () => {
	await appendSend();
	await append(notificationRequest('later'));
	await source.query("UPDATE backend_internal.work_control SET reserved_dispatches=10000 WHERE queue_key='deliver'");
	const sent: string[] = [];
	await scanPostWork(store, { enqueue: async value => {
		sent.push(value.queueKey);
	}, retire: async () => true }, 'scanner');
	expect(sent).toEqual(['postLocal']);
	expect(await items()).toEqual([
		{ state: 'ready', attempt_count: 0, seq: 1 }, { state: 'retry_wait', attempt_count: 0, seq: 0 },
	]);
	expect(await source.query("SELECT reason_code, dispatch_owner, dispatch_until FROM backend_internal.work_item WHERE request_id='request'"))
		.toEqual([{ reason_code: 'capacity_wait', dispatch_owner: null, dispatch_until: null }]);
});

test('same owner cannot confirm an expired claim or an older sequence', async () => {
	await appendSend();
	const first = await store.claim('same');
	if (first.status !== 'claimed') {
		throw new Error('missing first claim');
	}
	await source.query("UPDATE backend_internal.work_item SET dispatch_until=clock_timestamp()-interval '1 second'");
	expect(await store.enqueued(first.reservation, 'same')).toBe(false);
	await source.query("UPDATE backend_internal.queue_dispatch SET reserved_at=reserved_at-interval '61 seconds', token_expires_at=token_expires_at-interval '61 seconds'");
	const second = await store.claim('same');
	if (second.status !== 'claimed') {
		throw new Error('missing second claim');
	}
	expect(second.reservation.dispatchSeq).toBe('2');
	expect(await store.enqueued(first.reservation, 'same')).toBe(false);
	expect(await store.enqueued(second.reservation, 'same')).toBe(true);
	expect((await store.claim('same')).status).toBe('empty');
});

test('enqueue ambiguity preserves the same reservation until retirement confirms release', async () => {
	await appendSend();
	const transport = { enqueue: async () => {
		throw new Error('lost response');
	}, retire: async () => false };
	await expect(scanPostWork(store, transport, 'scanner')).rejects.toThrow('lost response');
	expect((await store.pending())).toHaveLength(1);
	await reconcilePostWork(store, transport);
	expect((await store.pending())).toHaveLength(1);
	await source.query("UPDATE backend_internal.queue_dispatch SET reserved_at=reserved_at-interval '61 seconds', token_expires_at=token_expires_at-interval '61 seconds'");
	await reconcilePostWork(store, { ...transport, retire: async () => true });
	await reconcilePostWork(store, { ...transport, retire: async () => true });
	expect(await store.pending()).toHaveLength(0);
	expect((await source.query("SELECT reserved_dispatches FROM backend_internal.work_control WHERE queue_key='deliver'"))[0].reserved_dispatches).toBe(0);
	expect(await items()).toEqual([{ state: 'ready', attempt_count: 0, seq: 1 }]);
});

test('schema matches and dispatch migration can be rolled back and applied again', async () => {
	await assertSchemaMatches(database.config.database);
	const migration = migrationSources(database.config.database).internal;
	await migration.initialize();
	try {
		await migration.undoLastMigration();
		await migration.undoLastMigration();
		await migration.undoLastMigration();
		await migration.undoLastMigration();
		await migration.undoLastMigration();
		await migration.undoLastMigration();
		expect((await source.query("SELECT to_regclass('backend_internal.queue_dispatch') AS relation"))[0].relation).toBe(null);
		await migration.runMigrations();
	} finally {
		await migration.destroy();
	}
	await assertSchemaMatches(database.config.database);
});

test('paused, future and executing items do not consume a dispatch or execution attempt', async () => {
	await appendSend(apRequest('paused'));
	await source.query("UPDATE backend_internal.work_control SET paused=true WHERE queue_key='deliver'");
	expect((await store.claim('scanner')).status).toBe('waiting');
	await append(notificationRequest('future'));
	await append(notificationRequest('executing'));
	await source.query("UPDATE backend_internal.work_item SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE request_id='notificationfuture'");
	await source.query("UPDATE backend_internal.work_item SET execution_owner='worker', execution_until=clock_timestamp()+interval '1 minute' WHERE request_id='notificationexecuting'");
	expect((await store.claim('scanner')).status).toBe('empty');
	expect((await items()).every((item: { seq: number; attempt_count: number }) => item.seq === 0 && item.attempt_count === 0)).toBe(true);
});

test('dispatch accounting respects the normal ninety percent threshold and delete reserve', async () => {
	const create = apRequest('normal');
	const deletion = apRequest('delete');
	deletion.noteGeneration = 2;
	deletion.eventId = 'delete-event';
	deletion.payload.activity.type = 'Delete';
	deletion.payload.activity.body = JSON.stringify({ id: deletion.payload.activity.id, type: 'Delete' });
	await appendSend(create);
	await appendSend(deletion);
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=900000');
	const results = [await store.claim('scanner'), await store.claim('scanner')];
	expect(results.map(result => result.status).sort()).toEqual(['claimed', 'waiting']);
	const claimed = results.find(result => result.status === 'claimed');
	if (claimed?.status !== 'claimed') {
		throw new Error('missing delete claim');
	}
	expect(claimed.reservation.workId).toBe((await source.query("SELECT work_id FROM backend_internal.work_item WHERE request_id='requestdelete'"))[0].work_id);
	expect((await source.query('SELECT reserved_rows::int AS rows FROM backend_internal.work_capacity'))[0].rows).toBe(900001);
	const [before] = await source.query('SELECT reserved_bytes FROM backend_internal.work_capacity');
	await store.release(claimed.reservation);
	expect((await source.query('SELECT reserved_bytes FROM backend_internal.work_capacity'))[0]).toEqual(before);
});

test('one scan handles at most one hundred candidates and leaves later durable work intact', async () => {
	const request = notificationRequest('batch');
	request.payload.candidates = Array.from({ length: 101 }, (_, i) => ({ recipientId: `recipient${i}`, type: 'mention' }));
	await append(request);
	let enqueues = 0;
	await scanPostWork(store, { enqueue: async () => {
		enqueues++;
	}, retire: async () => true }, 'scanner');
	expect(enqueues).toBe(100);
	expect((await items()).filter((item: { seq: number }) => item.seq === 0)).toHaveLength(1);
	expect((await source.query('SELECT count(*)::int AS count FROM backend_internal.queue_dispatch'))[0].count).toBe(100);
});

test('failed reconciliation preserves queue capacity for a later confirmed recovery', async () => {
	await appendSend();
	const result = await store.claim('scanner');
	if (result.status !== 'claimed') {
		throw new Error('missing claim');
	}
	await source.query("UPDATE backend_internal.queue_dispatch SET reserved_at=reserved_at-interval '61 seconds', token_expires_at=token_expires_at-interval '61 seconds'");
	await expect(reconcilePostWork(store, {
		enqueue: async () => {}, retire: async () => {
			throw new Error('Redis response lost');
		},
	})).rejects.toThrow('Redis response lost');
	expect(await store.pending()).toHaveLength(1);
	expect((await source.query("SELECT reserved_dispatches FROM backend_internal.work_control WHERE queue_key='deliver'"))[0].reserved_dispatches).toBe(1);
});

test('recovers a real enqueue with a lost response using the same durable work ID', async () => {
	await append(notificationRequest('redis'));
	const connection = { host: '127.0.0.1', port: database.config.redis.port, maxRetriesPerRequest: null };
	const prefix = `dispatch-${randomUUID()}`;
	const transport = new BullmqDispatch(connection, prefix);
	const queue = new Queue('postLocal', { connection, prefix });
	try {
		await transport.initialize('postLocal', '1');
		await expect(scanPostWork(store, {
			enqueue: async (value, now) => {
				await transport.enqueue(value, now);
				throw new Error('enqueue response lost');
			},
			retire: value => transport.retire(value),
		}, 'scanner')).rejects.toThrow('enqueue response lost');
		expect(await queue.getWaitingCount()).toBe(1);
		const [original] = await store.pending();
		await expect.poll(async () => (await store.pending(100, true)).length, { timeout: 65000, interval: 500 }).toBe(1);
		await reconcilePostWork(store, transport);
		expect(await queue.getWaitingCount()).toBe(0);
		expect(await store.pending()).toHaveLength(0);
		await source.query("UPDATE backend_internal.work_item SET dispatch_until=clock_timestamp()-interval '1 second'");
		await scanPostWork(store, transport, 'scanner');
		expect(await queue.getWaitingCount()).toBe(1);
		const [retry] = await store.pending();
		expect(retry.workId).toBe(original.workId);
		expect(retry.dispatchSeq).toBe('2');
		expect(await items()).toEqual([{ state: 'ready', attempt_count: 0, seq: 2 }]);
	} finally {
		await transport.close();
		await queue.obliterate({ force: true });
		await queue.close();
	}
});

test('AP expansion uses the local queue and also honors deliver pause', async () => {
	await append(apRequest());
	await source.query("UPDATE backend_internal.work_control SET paused=true WHERE queue_key='deliver'");
	expect((await store.claim('scanner')).status).toBe('waiting');
	await source.query("UPDATE backend_internal.work_control SET paused=false WHERE queue_key='deliver'");
	await source.query("UPDATE backend_internal.work_item SET next_attempt_at=clock_timestamp()");
	const result = await store.claim('scanner');
	if (result.status !== 'claimed') {
		throw new Error('missing expansion claim');
	}
	expect(result.reservation.queueKey).toBe('postLocal');
});

test('active reservations in the first batch do not starve a later completed entry', async () => {
	const request = notificationRequest('reconcile');
	request.payload.candidates = Array.from({ length: 101 }, (_, i) => ({ recipientId: `recipient${i}`, type: 'mention' }));
	await append(request);
	const transport = { enqueue: async () => {}, retire: async () => false };
	await scanPostWork(store, transport, 'scanner');
	await scanPostWork(store, transport, 'scanner');
	await source.query("UPDATE backend_internal.queue_dispatch SET reserved_at=reserved_at-interval '61 seconds', token_expires_at=token_expires_at-interval '61 seconds'");
	const rows = await source.query('SELECT work_id FROM backend_internal.queue_dispatch ORDER BY last_checked_at, work_id, dispatch_seq');
	const later = rows[100].work_id;
	const recovery = { ...transport, retire: async (value: { workId: string }) => value.workId === later };
	await reconcilePostWork(store, recovery);
	expect((await source.query("SELECT reserved_dispatches FROM backend_internal.work_control WHERE queue_key='postLocal'"))[0].reserved_dispatches).toBe(101);
	await reconcilePostWork(store, recovery);
	expect((await source.query("SELECT reserved_dispatches FROM backend_internal.work_control WHERE queue_key='postLocal'"))[0].reserved_dispatches).toBe(100);
});

test('low physical capacity does not create dispatch rows or advance sequence or attempt', async () => {
	await appendSend();
	await source.query('UPDATE backend_internal.work_capacity SET physical_free_bytes=1');
	expect(await store.claim('scanner')).toEqual({ status: 'waiting' });
	expect(await source.query('SELECT count(*)::int AS count FROM backend_internal.queue_dispatch')).toEqual([{ count: 0 }]);
	expect(await items()).toEqual([{ state: 'retry_wait', attempt_count: 0, seq: 0 }]);
});
