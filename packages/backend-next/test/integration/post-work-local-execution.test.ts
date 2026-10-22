/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeAll, beforeEach, afterAll, expect, test } from 'vitest';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { PostWorkDispatchStore } from '../../src/platform/database/post-work/dispatch.js';
import { PostWorkLocalExecutionStore, withLocalWorkCompletion } from '../../src/platform/database/post-work/local-execution.js';
import { createTestDatabase } from '../helpers/database.js';
import { apRequest, notificationRequest } from '../helpers/post-work.js';
import type { LocalExecutionClaim, LocalExecutionEnvelope } from '../../src/platform/jobs/local-execution.js';
import type { DataSource, EntityManager } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let dispatch: PostWorkDispatchStore;
let execution: PostWorkLocalExecutionStore;

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	dispatch = new PostWorkDispatchStore(source);
	execution = new PostWorkLocalExecutionStore(source, () => 0);
	// A test-only effect sink exercises transaction rollback without inventing product Note/notification storage.
	await source.query('CREATE TABLE execution_probe (id text PRIMARY KEY)');
});
beforeEach(async () => {
	await source.query('TRUNCATE execution_probe, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.query('UPDATE backend_internal.work_control SET reserved_dispatches=0, paused=false, queue_generation=1');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3, reserved_bytes=6144');
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

async function seed(ap = false, count = 1, ageMs = 1000): Promise<LocalExecutionEnvelope> {
	const request = ap ? apRequest() : notificationRequest();
	if (request.kind === 'notification.create') {
		request.payload.candidates = Array.from({ length: count }, (_, i) => ({ recipientId: `recipient${i}`, type: 'mention' }));
	}
	request.occurredAtMs = Date.now() - ageMs;
	request.notBeforeMs = request.occurredAtMs;
	await source.transaction(manager => withPostWorkRequests(manager, work => work.append(request)));
	const claim = await dispatch.claim('scanner');
	if (claim.status !== 'claimed') {
		throw new Error('Missing dispatch');
	}
	const { workId, kind, schemaVersion, dispatchSeq, queueGeneration } = claim.reservation;
	return { workId, kind, schemaVersion, dispatchSeq, queueGeneration };
}

async function claim(value: LocalExecutionEnvelope, owner = 'worker'): Promise<LocalExecutionClaim> {
	const result = await execution.claim(value, owner);
	if (!result) {
		throw new Error('Missing execution claim');
	}
	return result;
}

const item = async () => (await source.query('SELECT * FROM backend_internal.work_item ORDER BY work_id'))[0];
const request = async () => (await source.query('SELECT state, finished_at FROM backend_internal.work_request'))[0];
const effect = async (manager: EntityManager, id = 'result') => {
	await manager.createQueryBuilder().insert().into('execution_probe').values({ id }).execute();
};

test('parallel local execution acquires one lease and consumes one attempt', async () => {
	const envelope = await seed();
	const results = await Promise.all(Array.from({ length: 8 }, (_, i) => execution.claim(envelope, `worker${i}`)));
	expect(results.filter(Boolean)).toHaveLength(1);
	expect(await item()).toMatchObject({ state: 'running', attempt_count: 1, execution_epoch: '1' });
	expect(results.find(Boolean)).toMatchObject({ kind: 'notification.create', payload: { recipientId: 'recipient0', type: 'mention' } });
});

test('AP expansion obtains its own validated request and root payload', async () => {
	const owned = await claim(await seed(true));
	expect(owned).toMatchObject({ kind: 'ap.expand', payload: {}, request: { kind: 'ap.expand', payload: { directActorIds: [] } } });
});

test.each(['kind', 'schemaVersion', 'dispatchSeq', 'queueGeneration', 'workId'])('forged %s leaves the item untouched', async key => {
	const envelope = await seed();
	const invalid = { ...envelope, [key]: key === 'schemaVersion' ? 2 : 'different' };
	expect(await execution.claim(invalid, 'worker')).toBe(null);
	expect(await item()).toMatchObject({ state: 'ready', attempt_count: 0, execution_epoch: '0' });
});

test.each(['released', 'retired'])('%s transport reservation grants no execution right', async state => {
	const envelope = await seed();
	await source.query('UPDATE backend_internal.queue_dispatch SET state=$1::varchar, released_at=CASE WHEN $1::varchar=\'released\' THEN clock_timestamp() ELSE NULL END', [state]);
	expect(await execution.claim(envelope, 'worker')).toBe(null);
	expect((await item()).attempt_count).toBe(0);
});

test('queue generation changes reject a previous envelope', async () => {
	const envelope = await seed();
	await source.query('UPDATE backend_internal.work_control SET queue_generation=2');
	expect(await execution.claim(envelope, 'worker')).toBe(null);
	expect((await item()).attempt_count).toBe(0);
});

test.each(['future', 'paused', 'active'])('%s waits without consuming an attempt', async condition => {
	const envelope = await seed();
	if (condition === 'future') {
		await source.query('UPDATE backend_internal.work_item SET next_attempt_at=clock_timestamp()+interval \'1 hour\'');
	} else if (condition === 'paused') {
		await source.query('UPDATE backend_internal.work_control SET paused=true WHERE queue_key=\'postLocal\'');
	} else {
		await claim(envelope);
	}
	expect(await execution.claim(envelope, 'other')).toBe(null);
	expect((await item()).attempt_count).toBe(condition === 'active' ? 1 : 0);
});

test('deliver pause prevents local AP expansion while notifications remain eligible', async () => {
	const envelope = await seed(true);
	await source.query('UPDATE backend_internal.work_control SET paused=true WHERE queue_key=\'deliver\'');
	expect(await execution.claim(envelope, 'worker')).toBe(null);
	expect(await item()).toMatchObject({ state: 'retry_wait', reason_code: 'paused', attempt_count: 0 });
});

test.each(['schema_version=2', 'payload=\'{}\'', 'payload_hash=repeat(\'0\',64)'])('damaged saved item %s is quarantined without executing', async damage => {
	const envelope = await seed();
	await source.query(`UPDATE backend_internal.work_item SET ${damage}`);
	const current = { ...envelope, schemaVersion: (await item()).schema_version };
	expect(await execution.claim(current, 'worker')).toBe(null);
	expect(await item()).toMatchObject({ state: 'quarantined', attempt_count: 0, reason_code: 'invalid_payload' });
	expect(await request()).toMatchObject({ state: 'needs_attention' });
});

test('saved request corruption is quarantined as well as item corruption', async () => {
	const envelope = await seed(true);
	await source.query('UPDATE backend_internal.work_request SET payload_hash=repeat(\'0\',64)');
	expect(await execution.claim(envelope, 'worker')).toBe(null);
	expect((await item()).state).toBe('quarantined');
});

test('note cancellation prevents an unstarted local job', async () => {
	const envelope = await seed();
	await source.query('UPDATE backend_internal.note_work_state SET generation=2, deleted_at=clock_timestamp(), cancel_event_id=\'delete\'');
	expect(await execution.claim(envelope, 'worker')).toBe(null);
	expect(await item()).toMatchObject({ state: 'cancelled', attempt_count: 0 });
});

test('expired lease can be reclaimed with the same owner but the old epoch cannot renew or finish', async () => {
	const envelope = await seed();
	const first = await claim(envelope);
	const deadline = (await item()).deadline_at;
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\'');
	expect(await execution.renew(first)).toBe(false);
	const second = await claim(envelope);
	expect(second.epoch).not.toBe(first.epoch);
	expect(await execution.renew(first)).toBe(false);
	await expect(execution.finish(first, { status: 'succeeded' })).rejects.toThrow('execution');
	expect(await execution.renew(second)).toBe(true);
	expect(await item()).toMatchObject({ attempt_count: 2, deadline_at: deadline });
});

test('business effect and successful progress commit together and never recreate an effect', async () => {
	const envelope = await seed();
	const owned = await claim(envelope);
	await source.transaction(async manager => {
		await withLocalWorkCompletion(manager, owned, async () => {
			await effect(manager);
			return { status: 'succeeded', resultRef: 'result' };
		});
	});
	expect(await item()).toMatchObject({ state: 'succeeded', result_ref: 'result', execution_owner: null });
	expect(await request()).toMatchObject({ state: 'settled' });
	expect(await execution.claim(envelope, 'other')).toBe(null);
	expect(await source.query('SELECT * FROM execution_probe')).toEqual([{ id: 'result' }]);
});

test('lost ownership rolls back business writes preceding completion', async () => {
	const owned = await claim(await seed());
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\'');
	await expect(source.transaction(async manager => {
		await withLocalWorkCompletion(manager, owned, async () => {
			await effect(manager);
			return { status: 'succeeded' };
		});
	})).rejects.toThrow('execution');
	expect(await source.query('SELECT * FROM execution_probe')).toEqual([]);
	expect((await item()).state).toBe('running');
});

test('completion cannot commit after its DB lease expires inside the transaction', async () => {
	const owned = await claim(await seed());
	await expect(source.transaction(async manager => {
		await withLocalWorkCompletion(manager, owned, async () => {
			await effect(manager);
			await manager.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\'');
			return { status: 'succeeded' };
		});
	})).rejects.toThrow('execution');
	expect(await source.query('SELECT * FROM execution_probe')).toEqual([]);
});

test('transaction failure rolls back progress and effect together', async () => {
	const owned = await claim(await seed());
	await expect(source.transaction(async manager => {
		await withLocalWorkCompletion(manager, owned, async () => {
			await effect(manager);
			return { status: 'succeeded' };
		});
		throw new Error('stop before commit');
	})).rejects.toThrow('stop before commit');
	expect(await source.query('SELECT * FROM execution_probe')).toEqual([]);
	expect((await item()).state).toBe('running');
});

test('retry consumes no additional attempt and preserves the original deadline', async () => {
	const owned = await claim(await seed());
	const before = Date.now();
	await execution.finish(owned, { status: 'retry', reason: 'temporary_failure' });
	const saved = await item();
	expect(saved).toMatchObject({ state: 'retry_wait', attempt_count: 1, execution_owner: null, reason_code: 'temporary_failure' });
	expect(saved.deadline_at.getTime()).toBe(owned.deadlineAtMs);
	expect(saved.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 60000);
	expect(saved.next_attempt_at.getTime()).toBeLessThan(Date.now() + 60100);
});

test('eighth local attempt is exhausted after failure', async () => {
	const envelope = await seed();
	await source.query('UPDATE backend_internal.work_item SET attempt_count=7');
	const owned = await claim(envelope);
	await execution.finish(owned, { status: 'retry', reason: 'temporary_failure' });
	expect(await item()).toMatchObject({ state: 'exhausted', attempt_count: 8 });
	expect(await request()).toMatchObject({ state: 'needs_attention' });
});

test.each(['skipped', 'cancelled', 'failed_permanent'] as const)('%s records a finite terminal reason', async status => {
	const owned = await claim(await seed());
	await execution.finish(owned, { status, reason: 'condition_changed' });
	expect(await item()).toMatchObject({ state: status, reason_code: 'condition_changed', execution_owner: null });
	expect(await request()).toMatchObject({ state: status === 'failed_permanent' ? 'needs_attention' : 'settled' });
});

test('concurrent siblings settle the request only when all items terminate', async () => {
	const first = await seed(false, 2);
	const next = await dispatch.claim('scanner');
	if (next.status !== 'claimed') {
		throw new Error('missing second dispatch');
	}
	const { workId, kind, schemaVersion, dispatchSeq, queueGeneration } = next.reservation;
	const claims = await Promise.all([claim(first), claim({ workId, kind, schemaVersion, dispatchSeq, queueGeneration })]);
	await Promise.all(claims.map(owned => execution.finish(owned, { status: 'succeeded' })));
	expect(await request()).toMatchObject({ state: 'settled' });
});

test('bounded expiry discovers deadline and attempt exhaustion outside the dispatch scan', async () => {
	await seed(false, 3);
	await source.query('UPDATE backend_internal.work_item SET deadline_at=clock_timestamp()-interval \'1 second\'');
	expect(await execution.expire(2)).toBe(2);
	expect((await source.query('SELECT count(*)::int AS count FROM backend_internal.work_item WHERE state=\'exhausted\''))[0].count).toBe(2);
	expect(await request()).toMatchObject({ state: 'open' });
	expect(await execution.expire(2)).toBe(1);
	expect(await request()).toMatchObject({ state: 'needs_attention' });
});

test('recovery does not steal an active lease and does not reset attempts', async () => {
	const owned = await claim(await seed());
	await source.query('UPDATE backend_internal.work_item SET attempt_count=8');
	expect(await execution.expire()).toBe(0);
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\'');
	expect(await execution.expire()).toBe(1);
	expect(await item()).toMatchObject({ state: 'exhausted', attempt_count: 8, execution_epoch: owned.epoch });
});

test('completion requires a caller-owned active transaction', async () => {
	const owned = await claim(await seed());
	await expect(withLocalWorkCompletion(source.manager, owned, async () => ({ status: 'succeeded' }))).rejects.toThrow('transaction');
});

test('renewal cannot revive a lease that expired while waiting for an unchanged row lock', async () => {
	const owned = await claim(await seed());
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()+interval \'250 milliseconds\'');
	const locker = source.createQueryRunner();
	await locker.connect();
	await locker.startTransaction();
	try {
		await locker.query('SELECT work_id FROM backend_internal.work_item FOR UPDATE');
		const renewing = execution.renew(owned);
		// Holding a row lock without changing it exercises PostgreSQL's no-EPQ path.
		await locker.query('SELECT pg_sleep(0.5)');
		await locker.commitTransaction();
		expect(await renewing).toBe(false);
	} finally {
		if (locker.isTransactionActive) {
			await locker.rollbackTransaction();
		}
		await locker.release();
	}
});

test('completion refuses cancellation before running the business callback', async () => {
	const owned = await claim(await seed());
	await source.query('UPDATE backend_internal.note_work_state SET generation=2, deleted_at=clock_timestamp(), cancel_event_id=\'delete\'');
	let invoked = false;
	await expect(source.transaction(manager => withLocalWorkCompletion(manager, owned, async () => {
		invoked = true;
		await effect(manager);
		return { status: 'succeeded' };
	}))).rejects.toThrow('execution');
	expect(invoked).toBe(false);
	expect(await source.query('SELECT * FROM execution_probe')).toEqual([]);
});

test('late retry reaching the fixed deadline becomes exhausted', async () => {
	const owned = await claim(await seed(false, 1, 86400000 - 30000));
	await execution.finish(owned, { status: 'retry', reason: 'temporary_failure' });
	expect(await item()).toMatchObject({ state: 'exhausted', attempt_count: 1 });
});

test('successful completion still checks the original deadline after the callback', async () => {
	const owned = await claim(await seed());
	await expect(source.transaction(manager => withLocalWorkCompletion(manager, owned, async () => {
		await effect(manager);
		await manager.query('UPDATE backend_internal.work_item SET deadline_at=clock_timestamp()-interval \'1 second\'');
		return { status: 'succeeded' };
	}))).rejects.toThrow('execution');
	expect(await source.query('SELECT * FROM execution_probe')).toEqual([]);
});

test('seventh-attempt retry caps the base delay at one hour with twenty percent maximum jitter', async () => {
	const envelope = await seed();
	await source.query('UPDATE backend_internal.work_item SET attempt_count=6');
	const owned = await claim(envelope);
	const before = Date.now();
	await new PostWorkLocalExecutionStore(source, () => 1).finish(owned, { status: 'retry', reason: 'temporary_failure' });
	const saved = await item();
	expect(saved).toMatchObject({ state: 'retry_wait', attempt_count: 7 });
	expect(saved.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 4320000);
	expect(saved.next_attempt_at.getTime()).toBeLessThan(Date.now() + 4320100);
});

test('unsupported external send and recipient-page jobs are left for their owning adapters', async () => {
	const envelope = await seed(true);
	for (const kind of ['ap.send', 'ap.expand.page']) {
		await source.query('UPDATE backend_internal.work_item SET kind=$1', [kind]);
		expect(await execution.claim({ ...envelope, kind }, 'worker')).toBe(null);
		expect(await item()).toMatchObject({ state: 'ready', attempt_count: 0, execution_epoch: '0' });
	}
});

test('recovery enforces its one-hundred-item batch limit and leaves further items durable', async () => {
	await seed(false, 101);
	await source.query('UPDATE backend_internal.work_item SET deadline_at=clock_timestamp()-interval \'1 second\'');
	expect(await execution.expire()).toBe(100);
	expect(await request()).toMatchObject({ state: 'open' });
	expect(await execution.expire()).toBe(1);
	expect(await request()).toMatchObject({ state: 'needs_attention' });
	await expect(execution.expire(101)).rejects.toThrow('batch size');
});

test('a failed sibling keeps the aggregate in needs_attention after all siblings finish', async () => {
	const first = await seed(false, 2);
	const next = await dispatch.claim('scanner');
	if (next.status !== 'claimed') {
		throw new Error('missing second dispatch');
	}
	const { workId, kind, schemaVersion, dispatchSeq, queueGeneration } = next.reservation;
	const firstClaim = await claim(first);
	const secondClaim = await claim({ workId, kind, schemaVersion, dispatchSeq, queueGeneration });
	await execution.finish(firstClaim, { status: 'failed_permanent', reason: 'condition_changed' });
	expect(await request()).toMatchObject({ state: 'open' });
	await execution.finish(secondClaim, { status: 'succeeded' });
	expect(await request()).toMatchObject({ state: 'needs_attention' });
});

test('an early item schedule cannot bypass the immutable request not-before time', async () => {
	const envelope = await seed();
	const now = Date.now();
	const notBefore = now + 60000;
	const deadline = notBefore + 86400000;
	await source.query('UPDATE backend_internal.work_request SET occurred_at=$1, not_before=$2, deadline_at=$3', [new Date(now), new Date(notBefore), new Date(deadline)]);
	await source.query('UPDATE backend_internal.work_item SET deadline_at=$1', [new Date(deadline)]);
	expect(await execution.claim(envelope, 'worker')).toBe(null);
	expect(await item()).toMatchObject({ state: 'ready', attempt_count: 0 });
});

test('an execution claim can share queue control reads with another transaction', async () => {
	const envelope = await seed();
	const locker = source.createQueryRunner();
	await locker.connect();
	await locker.startTransaction();
	let pending: Promise<LocalExecutionClaim | null> | undefined;
	try {
		await locker.query('SELECT queue_key FROM backend_internal.work_control WHERE queue_key=\'postLocal\' FOR SHARE');
		pending = execution.claim(envelope, 'worker');
		await expect.poll(async () => (await item()).state, { timeout: 1500, interval: 25 }).toBe('running');
	} finally {
		await locker.rollbackTransaction();
		await locker.release();
		await pending;
	}
});

test.each(['pause', 'generation'])('control %s committed during a lock wait is checked before execution', async change => {
	const envelope = await seed();
	const locker = source.createQueryRunner();
	await locker.connect();
	await locker.startTransaction();
	let pending: Promise<LocalExecutionClaim | null> | undefined;
	try {
		await locker.query('SELECT queue_key FROM backend_internal.work_control WHERE queue_key=\'postLocal\' FOR UPDATE');
		const [{ pid }] = await locker.query('SELECT pg_backend_pid() AS pid');
		pending = execution.claim(envelope, 'worker');
		await expect.poll(async () => (await source.query(
			'SELECT EXISTS(SELECT 1 FROM pg_stat_activity AS activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(activity.pid))) AS blocked', [pid],
		))[0].blocked, { timeout: 1500, interval: 25 }).toBe(true);
		await locker.query(change === 'pause'
			? 'UPDATE backend_internal.work_control SET paused=true WHERE queue_key=\'postLocal\''
			: 'UPDATE backend_internal.work_control SET queue_generation=2 WHERE queue_key=\'postLocal\'');
		await locker.commitTransaction();
		expect(await pending).toBe(null);
		expect((await item()).attempt_count).toBe(0);
	} finally {
		if (locker.isTransactionActive) {
			await locker.rollbackTransaction();
		}
		await locker.release();
		await pending;
	}
});
