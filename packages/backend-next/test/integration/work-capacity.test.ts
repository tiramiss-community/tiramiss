/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { apRequest } from '../helpers/post-work.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { WorkCapacityExceeded } from '../../src/modules/post-work/public.js';
import type { DataSource } from 'typeorm';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('freshly migrated database refuses new business without a physical observation and leaves no rows', async () => {
	await expect(source.transaction(manager => withPostWorkRequests(manager, work => work.append(apRequest()))))
		.rejects.toBeInstanceOf(WorkCapacityExceeded);
	expect(await source.query('SELECT count(*)::int AS count FROM backend_internal.work_request')).toEqual([{ count: 0 }]);
});

import { recordVolumeObservation } from '../../src/platform/database/work-capacity/observation.js';
import { assertWorkCapacity, reconcileWorkCapacity } from '../../src/platform/database/work-capacity/accounting.js';
import { PostWorkDispatchStore } from '../../src/platform/database/post-work/dispatch.js';
const healthy = async () => recordVolumeObservation(source, {
	volumeId: 'postgres-data', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '2147483648',
}, 'postgres-data');
const append = (suffix: string) => source.transaction(manager => withPostWorkRequests(manager, work => work.append(apRequest(suffix))));

test('stops new admission and cancellation below threshold, preserves committed work and resumes with a new healthy sample', async () => {
	await healthy();
	await append('committed');
	await recordVolumeObservation(source, { volumeId: 'postgres-data', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '2147483647' }, 'postgres-data');
	await expect(append('rejected')).rejects.toBeInstanceOf(WorkCapacityExceeded);
	await expect(append('committed')).rejects.toBeInstanceOf(WorkCapacityExceeded);
	const request = apRequest('committed');
	await expect(source.transaction(manager => withPostWorkRequests(manager, work => work.append({
		...request, requestId: 'delete', eventId: 'delete-event', noteGeneration: 2,
		payload: { ...request.payload, activity: { ...request.payload.activity, type: 'Delete', body: JSON.stringify({ id: request.payload.activity.id, type: 'Delete' }) } },
	})))).rejects.toBeInstanceOf(WorkCapacityExceeded);
	expect(await source.query('SELECT generation FROM backend_internal.note_work_state')).toEqual([{ generation: 1 }]);
	expect(await source.query('SELECT count(*)::int AS count FROM backend_internal.work_request')).toEqual([{ count: 1 }]);
	await healthy();
	await expect(append('recovered')).resolves.toEqual({ requestId: 'requestrecovered' });
});

test('does not extend a stale sample by rereading it or replace a newer low-space observation with an older healthy one', async () => {
	await healthy();
	await source.query("UPDATE backend_internal.work_capacity SET physical_observed_at=clock_timestamp()-interval '120 seconds'");
	await expect(append('stale')).rejects.toBeInstanceOf(WorkCapacityExceeded);
	await expect(recordVolumeObservation(source, { volumeId: 'wrong', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '2147483648' }, 'postgres-data')).rejects.toThrow();
	await recordVolumeObservation(source, { volumeId: 'postgres-data', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '1' }, 'postgres-data');
	await recordVolumeObservation(source, { volumeId: 'postgres-data', observedAtMs: Date.now() - 1000, totalBytes: '21474836480', freeBytes: '2147483648' }, 'postgres-data');
	await expect(append('old')).rejects.toBeInstanceOf(WorkCapacityExceeded);
});

test('rechecks freshness after waiting for an unchanged capacity row lock', async () => {
	await healthy();
	await source.query("UPDATE backend_internal.work_capacity SET physical_observed_at=clock_timestamp()-interval '119 seconds'");
	const blocker = source.createQueryRunner();
	await blocker.connect();
	await blocker.startTransaction();
	await blocker.query('SELECT * FROM backend_internal.work_capacity FOR UPDATE');
	const result = Promise.allSettled([append('expired-during-lock')]);
	try {
		await expect.poll(async () => (await source.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"))[0].n).toBeGreaterThan(0);
		await source.query('SELECT pg_sleep(1.2)');
	} finally {
		await blocker.rollbackTransaction();
		await blocker.release();
	}
	const [outcome] = await result;
	expect(outcome.status).toBe('rejected');
	if (outcome.status === 'rejected') {
		expect(outcome.reason).toBeInstanceOf(WorkCapacityExceeded);
	}
	expect(await source.query("SELECT count(*)::int AS n FROM backend_internal.work_request WHERE request_id='requestexpired-during-lock'")).toEqual([{ n: 0 }]);
});

test('checks saved sums at startup, repairs counters only offline and atomically rolls back overflowing coefficient increases', async () => {
	await assertWorkCapacity(source);
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=reserved_rows+1');
	await expect(assertWorkCapacity(source)).rejects.toThrow('WORK_CAPACITY_RECONCILIATION_REQUIRED');
	await reconcileWorkCapacity(source);
	await assertWorkCapacity(source);
	const [savedItem] = await source.query('SELECT work_id,charged_bytes FROM backend_internal.work_item LIMIT 1');
	await source.query('UPDATE backend_internal.work_item SET charged_bytes=$1 WHERE work_id=$2', [21 * 1024 ** 3, savedItem.work_id]);
	await expect(assertWorkCapacity(source)).rejects.toThrow('WORK_CAPACITY_LIMIT_EXCEEDED');
	await source.query('UPDATE backend_internal.work_item SET charged_bytes=$1 WHERE work_id=$2', [savedItem.charged_bytes, savedItem.work_id]);
	await source.query('UPDATE backend_internal.work_item SET capacity_formula_version=2 WHERE work_id=$1', [savedItem.work_id]);
	await expect(assertWorkCapacity(source)).rejects.toThrow('WORK_CAPACITY_RECONCILIATION_REQUIRED');
	await source.query('UPDATE backend_internal.work_item SET capacity_formula_version=1 WHERE work_id=$1', [savedItem.work_id]);
	const before = await source.query('SELECT * FROM backend_internal.work_capacity');
	await expect(reconcileWorkCapacity(source, { coefficient: 2147483647, formulaVersion: 2 })).rejects.toThrow();
	expect(await source.query('SELECT * FROM backend_internal.work_capacity')).toEqual(before);
	await reconcileWorkCapacity(source, { coefficient: 8, formulaVersion: 2 });
	await expect(assertWorkCapacity(source)).rejects.toThrow('WORK_CAPACITY_RECONCILIATION_REQUIRED');
	await assertWorkCapacity(source, { coefficient: 8, formulaVersion: 2 });
	await expect(reconcileWorkCapacity(source)).rejects.toThrow();
	await reconcileWorkCapacity(source, { coefficient: 64, formulaVersion: 3 });
	await assertWorkCapacity(source, { coefficient: 64, formulaVersion: 3 });
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollWorkCapacity } from '../../src/platform/work-capacity-monitor.js';
import { createLogger } from '../../src/platform/logger.js';
const logger = createLogger('capacity-test', () => {});

test('file monitoring fails closed on missing, oversized, wrong-volume and stale input and recovers from a valid supplier', async () => {
	// The previous case intentionally left a future coefficient; this test uses observation-only paths.
	const directory = await mkdtemp(join(tmpdir(), 'capacity-source-'));
	const options = { file: join(directory, 'volume.json'), volumeId: 'postgres-data' };
	try {
		await source.query('UPDATE backend_internal.work_capacity SET physical_observed_at=NULL');
		expect(await pollWorkCapacity(source, options, logger)).toBe(false);
		await writeFile(options.file, ' '.repeat(5000));
		expect(await pollWorkCapacity(source, options, logger)).toBe(false);
		await writeFile(options.file, JSON.stringify({ volumeId: 'wrong', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '2147483648' }));
		expect(await pollWorkCapacity(source, options, logger)).toBe(false);
		await writeFile(options.file, JSON.stringify({ volumeId: 'postgres-data', observedAtMs: Date.now() - 120001, totalBytes: '21474836480', freeBytes: '2147483648' }));
		expect(await pollWorkCapacity(source, options, logger)).toBe(false);
		await writeFile(options.file, JSON.stringify({ volumeId: 'postgres-data', observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '2147483648' }));
		expect(await pollWorkCapacity(source, options, logger)).toBe(true);
	} finally {
		await rm(directory, { recursive: true });
	}
});

import { vi } from 'vitest';
import { startWorkCapacityMonitor } from '../../src/platform/work-capacity-monitor.js';

test('managed monitoring polls every 60 seconds, recovers from low space and stops polling when closed', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'capacity-timer-'));
	const options = { file: join(directory, 'volume.json'), volumeId: 'postgres-data' };
	const write = async (freeBytes: string) => writeFile(options.file, JSON.stringify({
		volumeId: options.volumeId, observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes,
	}));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	let close = async () => {};
	try {
		await write('1');
		close = await startWorkCapacityMonitor(source, options, logger);
		await new Promise(resolve => setTimeout(resolve, 2));
		await write('2147483648');
		await vi.advanceTimersByTimeAsync(59999);
		expect((await source.query('SELECT physical_free_bytes FROM backend_internal.work_capacity'))[0].physical_free_bytes).toBe('1');
		await vi.advanceTimersByTimeAsync(1);
		await expect.poll(async () => (await source.query('SELECT physical_free_bytes FROM backend_internal.work_capacity'))[0].physical_free_bytes).toBe('2147483648');
		await close();
		await write('1');
		await vi.advanceTimersByTimeAsync(120000);
		expect((await source.query('SELECT physical_free_bytes FROM backend_internal.work_capacity'))[0].physical_free_bytes).toBe('2147483648');
	} finally {
		await close();
		vi.useRealTimers();
		await rm(directory, { recursive: true });
	}
});

test('a stale healthy supplier reports the newer shared low-space state, and DB observation write failure never refreshes it', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'capacity-shared-'));
	const options = { file: join(directory, 'volume.json'), volumeId: 'postgres-data' };
	const old = Date.now() - 1000;
	try {
		await recordVolumeObservation(source, { volumeId: options.volumeId, observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '1' }, options.volumeId);
		await writeFile(options.file, JSON.stringify({ volumeId: options.volumeId, observedAtMs: old, totalBytes: '21474836480', freeBytes: '2147483648' }));
		expect(await pollWorkCapacity(source, options, logger)).toBe(false);
		const before = await source.query('SELECT physical_observed_at,physical_free_bytes FROM backend_internal.work_capacity');
		await source.query("CREATE FUNCTION backend_internal.reject_monitor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected disk write failure'; END $$");
		await source.query('CREATE TRIGGER reject_monitor BEFORE UPDATE ON backend_internal.work_capacity FOR EACH ROW EXECUTE FUNCTION backend_internal.reject_monitor()');
		try {
			await writeFile(options.file, JSON.stringify({ volumeId: options.volumeId, observedAtMs: Date.now(), totalBytes: '21474836480', freeBytes: '2147483648' }));
			expect(await pollWorkCapacity(source, options, logger)).toBe(false);
			expect(await source.query('SELECT physical_observed_at,physical_free_bytes FROM backend_internal.work_capacity')).toEqual(before);
		} finally {
			await source.query('DROP TRIGGER reject_monitor ON backend_internal.work_capacity');
			await source.query('DROP FUNCTION backend_internal.reject_monitor()');
		}
	} finally {
		await rm(directory, { recursive: true });
	}
});

test('offline coefficient increases atomically include the capacity row itself even in an empty database', async () => {
	const empty = await createTestDatabase();
	let other: DataSource | undefined;
	try {
		await migrateDatabase(empty.config.database);
		other = await createDataSource(empty.config.database).initialize();
		await reconcileWorkCapacity(other, { coefficient: 16, formulaVersion: 2 });
		await assertWorkCapacity(other, { coefficient: 16, formulaVersion: 2 });
		expect(await other.query('SELECT reserved_rows,reserved_bytes,charged_bytes FROM backend_internal.work_capacity')).toEqual([{ reserved_rows: '3', reserved_bytes: '24576', charged_bytes: '8192' }]);
	} finally {
		await other?.destroy();
		await empty.close();
	}
});
