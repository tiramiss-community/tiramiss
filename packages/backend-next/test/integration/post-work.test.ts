/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MiUser } from 'backend-upstream/entities';
import type { DataSource } from 'typeorm';
import type { PostWorkRequest, PostWorkRequests } from '../../src/modules/post-work/public.js';
import { InvalidPostWorkRequest, WorkCapacityExceeded, WorkRequestConflict } from '../../src/modules/post-work/public.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { workCapacity } from '../../src/modules/post-work/prepare.js';
import { createTestDatabase } from '../helpers/database.js';
import { apRequest, notificationRequest } from '../helpers/post-work.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
const capacity = () => source.query('SELECT reserved_rows::int AS rows, reserved_bytes::bigint::text AS bytes FROM backend_internal.work_capacity');
const append = (request: PostWorkRequest) => source.transaction(manager => withPostWorkRequests(manager, work => work.append(request)));
const count = async (table: string) => (await source.query(`SELECT count(*)::int AS count FROM backend_internal.${table}`))[0].count;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	await source.getRepository(MiUser).insert({ id: 'actor', username: 'actor', usernameLower: 'actor' });
});

beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows = 3, reserved_bytes = charged_bytes + 4096');
	await source.getRepository(MiUser).update({ id: 'actor' }, { notesCount: 0 });
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('commits business data, AP and notification requests/items and capacity together; rolls all back on failure', async () => {
	const initial = await capacity();
	const work = async (fail: boolean) => source.transaction(manager => withPostWorkRequests(manager, async requests => {
		await manager.getRepository(MiUser).increment({ id: 'actor' }, 'notesCount', 1);
		await requests.append(apRequest());
		await requests.append(notificationRequest());
		if (fail) {
			throw new Error('business failure');
		}
	}));
	await expect(work(true)).rejects.toThrow('business failure');
	expect(await capacity()).toEqual(initial);
	expect(await count('work_request')).toBe(0);
	expect(await count('work_item')).toBe(0);
	expect(await count('note_work_state')).toBe(0);
	expect((await source.getRepository(MiUser).findOneByOrFail({ id: 'actor' })).notesCount).toBe(0);
	await work(false);
	expect(await count('work_request')).toBe(2);
	expect(await count('work_item')).toBe(2);
	expect((await source.getRepository(MiUser).findOneByOrFail({ id: 'actor' })).notesCount).toBe(1);
	const [totals] = await source.query(`SELECT sum(n)::int AS rows, sum(b)::text AS bytes FROM (
		SELECT count(*) n, sum(charged_bytes) b FROM backend_internal.work_request UNION ALL
		SELECT count(*), sum(charged_bytes) FROM backend_internal.work_item UNION ALL
		SELECT count(*), sum(charged_bytes) FROM backend_internal.note_work_state UNION ALL
		SELECT count(*), sum(charged_bytes) FROM backend_internal.work_capacity UNION ALL
		SELECT count(*), sum(charged_bytes) FROM backend_internal.work_control) s`);
	expect(await capacity()).toEqual([totals]);
});

test('resolves another requestId for the same event/kind/generation without resetting progress or charging twice', async () => {
	expect(await append(apRequest())).toEqual({ requestId: 'request' });
	await source.query("UPDATE backend_internal.work_item SET state='retry_wait', attempt_count=3, execution_epoch=7, reason_code='retryable' WHERE request_id='request'");
	const initial = await capacity();
	expect(await append({ ...apRequest(), requestId: 'different' })).toEqual({ requestId: 'request' });
	expect(await count('work_request')).toBe(1);
	expect(await capacity()).toEqual(initial);
	expect(await source.query('SELECT state, attempt_count, execution_epoch::int FROM backend_internal.work_item')).toEqual([{ state: 'retry_wait', attempt_count: 3, execution_epoch: 7 }]);
});

test('keeps distinct events separate even with identical payload, and rejects reused PKs or changed immutable facts', async () => {
	await append(apRequest());
	const initial = await capacity();
	await expect(append({ ...apRequest(), eventId: 'other' })).rejects.toBeInstanceOf(WorkRequestConflict);
	await expect(append({ ...apRequest(), actorId: 'other' })).rejects.toBeInstanceOf(WorkRequestConflict);
	await expect(append({ ...apRequest(), notBeforeMs: apRequest().notBeforeMs + 1 })).rejects.toBeInstanceOf(WorkRequestConflict);
	await expect(append({ ...apRequest(), payload: { ...apRequest().payload, directActorIds: ['other'] } })).rejects.toBeInstanceOf(WorkRequestConflict);
	expect(await capacity()).toEqual(initial);
	await append({ ...apRequest(), requestId: 'second', eventId: 'second', noteId: 'second' });
	expect(await count('work_request')).toBe(2);
});

test('compares full immutable payload even when stored hash matches, and refuses append after body purge', async () => {
	await append(apRequest());
	await source.query("UPDATE backend_internal.work_request SET payload=jsonb_set(payload::jsonb,'{directActorIds}','[\"changed\"]')::text");
	await expect(append(apRequest())).rejects.toBeInstanceOf(WorkRequestConflict);
	await source.query("UPDATE backend_internal.work_request SET payload=NULL, state='settled', finished_at=clock_timestamp()");
	await expect(append({ ...apRequest(), requestId: 'new' })).rejects.toBeInstanceOf(WorkRequestConflict);
	expect(await count('work_item')).toBe(1);
});

test('concurrent equivalent requests yield a single canonical request and one reservation', async () => {
	const results = await Promise.all(Array.from({ length: 8 }, (_, i) => append({ ...apRequest(), requestId: `parallel-${i}` })));
	expect(new Set(results.map(result => result.requestId)).size).toBe(1);
	expect(await count('work_request')).toBe(1);
	expect(await count('work_item')).toBe(1);
});

function deletion(): PostWorkRequest {
	const request = apRequest();
	const id = 'https://example.test/activities/delete';
	return {
		...request, requestId: 'delete-request', eventId: 'delete-event', noteGeneration: 2,
		payload: { ...request.payload, activity: { id, type: 'Delete', body: JSON.stringify({ id, type: 'Delete' }) } },
	};
}

test('serializes generation changes and rejects late creation jobs without reviving or rewriting previous progress', async () => {
	await append(apRequest());
	await Promise.all([append({ ...apRequest(), requestId: 'retry' }), append(deletion())]);
	expect(await source.query('SELECT generation, cancel_event_id, recipient_coverage FROM backend_internal.note_work_state')).toEqual([{ generation: 2, cancel_event_id: 'delete-event', recipient_coverage: 'not_started' }]);
	expect(await append(apRequest())).toEqual({ requestId: 'request' });
	await expect(append(notificationRequest())).rejects.toBeInstanceOf(WorkRequestConflict);
	await expect(append({ ...deletion(), eventId: 'another-delete', requestId: 'another-delete' })).rejects.toBeInstanceOf(WorkRequestConflict);
	expect(await count('work_request')).toBe(2);
});

test('records unavailable coverage for a migrated/deleted note without inventing a creation event', async () => {
	await append(deletion());
	expect(await source.query('SELECT generation, create_event_id, recipient_coverage FROM backend_internal.note_work_state')).toEqual([{ generation: 2, create_event_id: null, recipient_coverage: 'unavailable' }]);
	await expect(append(apRequest())).rejects.toBeInstanceOf(WorkRequestConflict);
});

test('reserves normal capacity at 90%, preserves delete capacity, and rolls back all state if either limit fails', async () => {
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=$1', [workCapacity.rows * 0.9]);
	await expect(append(apRequest())).rejects.toBeInstanceOf(WorkCapacityExceeded);
	expect(await count('work_request')).toBe(0);
	expect(await count('note_work_state')).toBe(0);
	await append(deletion());
	expect(await count('work_request')).toBe(1);
	await source.query('UPDATE backend_internal.work_capacity SET reserved_bytes=$1', [workCapacity.bytes]);
	await expect(append({ ...deletion(), noteId: 'another-note', requestId: 'other-delete', eventId: 'other-event' })).rejects.toBeInstanceOf(WorkCapacityExceeded);
	expect(await count('work_request')).toBe(1);
	expect(await count('note_work_state')).toBe(1);
});

test('competing producers cannot overrun the final normal row slots', async () => {
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=$1', [workCapacity.rows * 0.9 - 3]);
	const results = await Promise.allSettled([append(apRequest('a')), append(apRequest('b'))]);
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
	expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
	expect((await capacity())[0].rows).toBe(900000);
	expect(await count('work_request')).toBe(1);
});

test('binds capabilities to an active transaction callback and expires them after both success and failure', async () => {
	await expect(withPostWorkRequests(source.manager, work => work.append(apRequest()))).rejects.toThrow('transaction');
	let escaped!: PostWorkRequests;
	await source.transaction(manager => withPostWorkRequests(manager, async work => {
		escaped = work;
		await work.append(apRequest());
	}));
	await expect(escaped.append(apRequest())).rejects.toThrow('ended');
	await expect(source.transaction(manager => withPostWorkRequests(manager, async work => {
		escaped = work;
		throw new Error('failed');
	}))).rejects.toThrow('failed');
	await expect(escaped.append(apRequest())).rejects.toThrow('ended');
});

test('does not commit partially after a caller catches an append rejection', async () => {
	await expect(source.transaction(manager => withPostWorkRequests(manager, async work => {
		await work.append(apRequest());
		await work.append({ ...notificationRequest(), schemaVersion: 2 } as unknown as PostWorkRequest).catch(() => undefined);
	}))).rejects.toBeInstanceOf(InvalidPostWorkRequest);
	expect(await count('work_request')).toBe(0);
});

test('does not automatically repeat a business transaction after a real COMMIT succeeds but its acknowledgement is lost', async () => {
	const original = source.createQueryRunner.bind(source);
	const acknowledgementLost = new Error('COMMIT acknowledgement lost');
	let executions = 0;
	const spy = vi.spyOn(source, 'createQueryRunner').mockImplementation(mode => {
		const runner = original(mode);
		const commit = runner.commitTransaction.bind(runner);
		runner.commitTransaction = async () => {
			await commit();
			throw acknowledgementLost;
		};
		return runner;
	});
	try {
		await expect(source.transaction(manager => withPostWorkRequests(manager, async work => {
			executions++;
			await manager.getRepository(MiUser).increment({ id: 'actor' }, 'notesCount', 1);
			await work.append(apRequest());
		}))).rejects.toBe(acknowledgementLost);
	} finally {
		spy.mockRestore();
	}
	expect(executions).toBe(1);
	expect(await count('work_request')).toBe(1);
	expect((await source.getRepository(MiUser).findOneByOrFail({ id: 'actor' })).notesCount).toBe(1);
});

test('checks internal schema drift and migration down/up without changing upstream schema or history', async () => {
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	await source.query('ALTER TABLE backend_internal.work_item ADD COLUMN unexpected text');
	await expect(assertSchemaMatches(database.config.database)).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
	await source.query('ALTER TABLE backend_internal.work_item DROP COLUMN unexpected');
	const before = await source.query('SELECT * FROM public.migrations ORDER BY id');
	const { internal } = migrationSources(database.config.database);
	await internal.initialize();
	try {
		await internal.undoLastMigration();
		await internal.undoLastMigration();
		await internal.undoLastMigration();
		expect(await source.query("SELECT to_regclass('backend_internal.work_request') AS name")).toEqual([{ name: null }]);
		await expect(assertMigrationsApplied(database.config.database)).rejects.toMatchObject({ code: 'PENDING_MIGRATIONS' });
		await internal.runMigrations();
	} finally {
		await internal.destroy();
	}
	expect(await source.query('SELECT * FROM public.migrations ORDER BY id')).toEqual(before);
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
});

test('drains started appends before returning or rolling back the enclosing transaction', async () => {
	let escaped!: PostWorkRequests;
	await source.transaction(manager => withPostWorkRequests(manager, async work => {
		escaped = work;
		void work.append(apRequest());
	}));
	expect(await count('work_request')).toBe(1);
	await expect(escaped.append(apRequest())).rejects.toThrow('ended');
	await expect(source.transaction(manager => withPostWorkRequests(manager, async work => {
		void work.append(apRequest('aborted'));
		throw new Error('abort with pending write');
	}))).rejects.toThrow('abort with pending write');
	expect(await count('work_request')).toBe(1);
	expect(await count('note_work_state')).toBe(1);
});

test('keeps the measured initial relations below saved logical charges for representative and maximum payloads', async () => {
	for (let batch = 0; batch < 8; batch++) {
		const request = notificationRequest(`size-${batch}`);
		await append({ ...request, payload: { candidates: Array.from({ length: 200 }, (_, i) => ({ recipientId: `recipient-${i}`, type: 'mention' as const })) } });
	}
	const measure = async () => {
		const [usage] = await source.query(`SELECT
			(SELECT reserved_bytes::text FROM backend_internal.work_capacity) AS reserved,
			(SELECT sum(pg_total_relation_size(oid))::text FROM pg_class
			WHERE relnamespace='backend_internal'::regnamespace AND relkind='r'
			AND relname IN ('work_request','work_item','note_work_state','work_capacity')) AS actual`);
		expect(Number(usage.actual)).toBeLessThanOrEqual(Number(usage.reserved));
		return usage;
	};
	await measure();
	const request = apRequest('maximum');
	const emptyBody = JSON.stringify({ id: request.payload.activity.id, type: 'Create', content: '' });
	const empty = { ...request, payload: { ...request.payload, activity: { ...request.payload.activity, body: emptyBody } } };
	const length = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty));
	const content = randomBytes(Math.ceil(length * 0.75) + 3).toString('base64').slice(0, length);
	const maximum = { ...request, payload: { ...request.payload, activity: { ...request.payload.activity, body: JSON.stringify({ id: request.payload.activity.id, type: 'Create', content }) } } };
	expect(Buffer.byteLength(JSON.stringify(maximum))).toBe(2 * 1024 * 1024);
	await append(maximum);
	const [stored] = await source.query('SELECT payload FROM backend_internal.work_request WHERE request_id=$1', [request.requestId]);
	expect(JSON.parse(stored.payload).activity.body).toBe(maximum.payload.activity.body);
	await measure();
});

test('resolves notification targets under the canonical request and rejects cross-note PK collisions without orphan rows', async () => {
	await append(notificationRequest());
	const initial = await capacity();
	expect(await append({ ...notificationRequest(), requestId: 'notification-alias' })).toEqual({ requestId: 'notification' });
	expect(await source.query('SELECT request_id, target_key FROM backend_internal.work_item')).toEqual([{ request_id: 'notification', target_key: '["recipient","mention"]' }]);
	const collision = { ...apRequest('collision'), requestId: 'notification' };
	await expect(append(collision)).rejects.toBeInstanceOf(WorkRequestConflict);
	expect(await count('note_work_state')).toBe(1);
	expect(await capacity()).toEqual(initial);
});

test.each(['work_item', 'work_capacity'])('database failure in %s rolls back business data and all work state', async table => {
	const initial = await capacity();
	await source.query(`CREATE FUNCTION backend_internal.reject_item_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'injected item failure'; END $$`);
	await source.query(`CREATE TRIGGER reject_item_for_test BEFORE ${table === 'work_item' ? 'INSERT' : 'UPDATE'} ON backend_internal.${table} FOR EACH ROW EXECUTE FUNCTION backend_internal.reject_item_for_test()`);
	try {
		await expect(source.transaction(manager => withPostWorkRequests(manager, async work => {
			await manager.getRepository(MiUser).increment({ id: 'actor' }, 'notesCount', 1);
			await work.append(apRequest());
		}))).rejects.toThrow('injected item failure');
	} finally {
		await source.query(`DROP TRIGGER reject_item_for_test ON backend_internal.${table}`);
		await source.query('DROP FUNCTION backend_internal.reject_item_for_test()');
	}
	expect(await count('note_work_state')).toBe(0);
	expect(await count('work_request')).toBe(0);
	expect(await count('work_item')).toBe(0);
	expect(await capacity()).toEqual(initial);
	expect((await source.getRepository(MiUser).findOneByOrFail({ id: 'actor' })).notesCount).toBe(0);
});

test('database constraints reject invalid counters, owners, UTF-8 widths and duplicate initial targets', async () => {
	await append(apRequest());
	for (const [assignment, values] of [
		['attempt_count=-1', []], ['execution_epoch=-1', []], ['dispatch_owner=$1', ['owner']],
		['reason_summary=$1', ['あ'.repeat(100)]], ['charged_bytes=1', []], ['schema_version=0', []],
	] as const) {
		await expect(source.transaction(manager => manager.query(`UPDATE backend_internal.work_item SET ${assignment}`, [...values]))).rejects.toMatchObject({ driverError: { code: '23514' } });
	}
	await expect(source.transaction(manager => manager.query(`INSERT INTO backend_internal.work_item
		(work_id,request_id,kind,target_key,schema_version,payload,payload_hash,next_attempt_at,deadline_at,charged_bytes)
		SELECT 'duplicate',request_id,kind,target_key,schema_version,payload,payload_hash,next_attempt_at,deadline_at,charged_bytes
		FROM backend_internal.work_item`))).rejects.toMatchObject({ driverError: { code: '23505' } });
	expect(await count('work_item')).toBe(1);
});

test('allows unrelated work to commit while another request is still inserting its items', async () => {
	const gate = source.createQueryRunner();
	await gate.connect();
	await gate.query('SELECT pg_advisory_lock(763148)');
	await source.query(`CREATE FUNCTION backend_internal.block_slow_item_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.request_id='notificationslow' THEN PERFORM pg_advisory_xact_lock(763148); END IF;
			RETURN NEW;
		END $$`);
	await source.query('CREATE TRIGGER block_slow_item_for_test BEFORE INSERT ON backend_internal.work_item FOR EACH ROW EXECUTE FUNCTION backend_internal.block_slow_item_for_test()');
	const request = notificationRequest('slow');
	const slow = Promise.allSettled([append({ ...request, payload: {
		candidates: Array.from({ length: 201 }, (_, i) => ({ recipientId: `recipient-${i}`, type: 'mention' as const })),
	} })]);
	let fast: Promise<PromiseSettledResult<{ requestId: string }>[]> | undefined;
	try {
		await expect.poll(async () => {
			const [result] = await source.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=763148 AND NOT granted) AS waiting");
			return result.waiting;
		}, { timeout: 5000 }).toBe(true);
		let committed = false;
		fast = Promise.allSettled([append(apRequest('fast')).then(result => {
			committed = true;
			return result;
		})]);
		await expect.poll(() => committed, { timeout: 5000 }).toBe(true);
	} finally {
		await gate.query('SELECT pg_advisory_unlock(763148)');
		await Promise.all([slow, fast]);
		await source.query('DROP TRIGGER block_slow_item_for_test ON backend_internal.work_item');
		await source.query('DROP FUNCTION backend_internal.block_slow_item_for_test()');
		await gate.release();
	}
	expect((await slow)[0].status).toBe('fulfilled');
	expect((await fast!)[0].status).toBe('fulfilled');
	expect(await count('work_request')).toBe(2);
	expect(await count('work_item')).toBe(202);
});

test('persists all notification targets across a partial final batch with exact payloads and shared deadlines', async () => {
	const request = notificationRequest('batch');
	const candidates = Array.from({ length: 101 }, (_, i) => ({ recipientId: `受信者'${i}:[]`, type: 'mention' as const }));
	await append({ ...request, payload: { candidates } });
	const rows: { target_key: string; payload: string; next_attempt_at: Date; deadline_at: Date; attempt_count: number; state: string }[] = await source.query(
		'SELECT target_key,payload,next_attempt_at,deadline_at,attempt_count,state FROM backend_internal.work_item WHERE request_id=$1', [request.requestId],
	);
	expect(rows).toHaveLength(candidates.length);
	expect(new Set(rows.map(row => row.target_key))).toEqual(new Set(candidates.map(candidate => JSON.stringify([candidate.recipientId, candidate.type]))));
	for (const row of rows) {
		const payload = JSON.parse(row.payload);
		expect(JSON.parse(row.target_key)).toEqual([payload.recipientId, payload.type]);
		expect(row.next_attempt_at.getTime()).toBe(request.notBeforeMs);
		expect(row.deadline_at.getTime()).toBe(request.notBeforeMs + 86400000);
		expect(row.state).toBe('ready');
		expect(row.attempt_count).toBe(0);
	}
});
