/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { PostApHostLeases } from '../../src/platform/database/ap/host-leases.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { workHash } from '../../src/modules/post-work/prepare.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { migrationSources } from '../../src/platform/database/migration-sources.js';
import { createTestDatabase } from '../helpers/database.js';
import { apRequest } from '../helpers/post-work.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
const store = new PostApHostLeases();
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
});
beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.ap_host_lease, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state CASCADE');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3,reserved_bytes=6144');
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

async function seed(suffix: string, inbox = 'https://remote.test/inbox') {
	const request = apRequest(suffix);
	request.occurredAtMs = Date.now() - 1000;
	request.notBeforeMs = request.occurredAtMs;
	await source.transaction(manager => withPostWorkRequests(manager, tx => tx.append(request)));
	const payload = JSON.stringify({ inbox, shared: false });
	// The send claim adapter is a later slice; this fixture models its same-transaction execution ownership.
	await source.query(`INSERT INTO backend_internal.work_item
		(work_id,request_id,kind,target_key,schema_version,payload,payload_hash,state,next_attempt_at,deadline_at,attempt_count,execution_owner,execution_epoch,execution_until,charged_bytes)
		VALUES ($1,$2,'ap.send',$3,1,$4,$5,'running',clock_timestamp(),clock_timestamp()+interval '1 day',1,'worker',1,clock_timestamp()+interval '60 seconds',7168)`,
	[suffix, request.requestId, inbox, payload, workHash(payload)]);
	return { workId: suffix, owner: 'worker', epoch: '1' };
}

type Execution = Awaited<ReturnType<typeof seed>>;
const acquire = (execution: Execution) => source.transaction(manager => store.acquire(manager, execution));
const slots = () => source.query('SELECT * FROM backend_internal.ap_host_lease ORDER BY host,slot');
const capacity = async () => (await source.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity'))[0];
const age = () => source.query('UPDATE backend_internal.ap_host_lease SET last_used_at=clock_timestamp()-interval \'31 days\',lease_until=CASE WHEN lease_id IS NULL THEN NULL ELSE clock_timestamp()-interval \'1 second\' END');

test('three concurrent executions get only two shared slots, while another host proceeds', async () => {
	const items = await Promise.all([seed('a'), seed('b'), seed('c'), seed('d', 'https://other.test/inbox')]);
	const before = await capacity();
	const results = await Promise.allSettled(items.slice(0, 3).map(acquire));
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
	expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { message: 'AP host slots unavailable' } }]);
	expect(await acquire(items[3])).toMatchObject({ host: 'other.test', slot: 0 });
	expect(await slots()).toHaveLength(4);
	const after = await capacity();
	expect(BigInt(after.reserved_rows) - BigInt(before.reserved_rows)).toBe(4n);
	// Each host slot: align1024(4 * (256 + 11 UTF-8 bytes)) = 2048.
	expect(BigInt(after.reserved_bytes) - BigInt(before.reserved_bytes)).toBe(8192n);
});

test.each([
	['https://REMOTE.test.:8443/a', 'http://remote.test/b', 'remote.test'],
	['https://例え.test/a', 'https://xn--r8jz45g.test:444/b', 'xn--r8jz45g.test'],
	['http://[2001:db8::1]:8000/a', 'https://[2001:0db8:0:0::1]/b', '[2001:db8::1]'],
])('host normalization groups %s and %s', async (first, second, host) => {
	const a = await seed('a', first);
	const b = await seed('b', second);
	expect(await acquire(a)).toMatchObject({ host, slot: 0 });
	expect(await acquire(b)).toMatchObject({ host, slot: 1 });
	await expect(acquire(await seed('c', first))).rejects.toThrow('slots unavailable');
	expect(await source.query('SELECT target_key FROM backend_internal.work_item WHERE work_id=\'a\'' )).toEqual([{ target_key: first }]);
});

test.each(['ftp://remote.test/inbox', 'https://user:secret@remote.test/inbox', 'invalid', 'http://./'])('invalid inbox %s creates no host rows', async inbox => {
	const item = await seed('a', inbox);
	const before = await capacity();
	await expect(acquire(item)).rejects.toThrow('host');
	expect(await slots()).toEqual([]);
	expect(await capacity()).toEqual(before);
});

test('repeated acquisition keeps one slot and its original expiry without charging twice', async () => {
	const item = await seed('a');
	const lease = await acquire(item);
	const before = await capacity();
	expect(await acquire(item)).toEqual(lease);
	expect(await capacity()).toEqual(before);
	expect((await slots()).filter((row: { work_id: string | null }) => row.work_id === 'a')).toHaveLength(1);
});

test.each(['owner', 'epoch', 'expired', 'deadline', 'cancelled', 'kind', 'state'])('%s prevents host acquisition', async change => {
	const item = await seed('a');
	if (change === 'owner' || change === 'epoch') {
		item[change] = '2';
	} else if (change === 'cancelled') {
		await source.query('UPDATE backend_internal.note_work_state SET generation=2,deleted_at=clock_timestamp(),cancel_event_id=\'cancel\'');
	} else {
		const updates: Record<string, string> = { expired: 'execution_until=clock_timestamp()-interval \'1 second\'', deadline: 'deadline_at=clock_timestamp()-interval \'1 second\'', kind: 'kind=\'notification.create\'', state: 'state=\'succeeded\'' };
		await source.query(`UPDATE backend_internal.work_item SET ${updates[change]} WHERE work_id='a'`);
	}
	await expect(acquire(item)).rejects.toThrow('execution');
	expect(await slots()).toEqual([]);
});

test('slot lease is capped by item lease, deadline and sixty seconds', async () => {
	const a = await seed('a');
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()+interval \'2 minutes\',deadline_at=clock_timestamp()+interval \'15 seconds\' WHERE work_id=\'a\'');
	const lease = await acquire(a);
	const [row] = await source.query('SELECT lease_until <= item.deadline_at AS deadline,lease_until <= item.execution_until AS execution,lease_until <= clock_timestamp()+interval \'60 seconds\' AS bounded FROM backend_internal.ap_host_lease host JOIN backend_internal.work_item item ON item.work_id=host.work_id WHERE host.work_id=\'a\'');
	expect(row).toEqual({ deadline: true, execution: true, bounded: true });
	expect(lease.hostEpoch).toBe('1');
});

test('host denial rolls back a caller execution claim and attempt increment', async () => {
	await acquire(await seed('a'));
	await acquire(await seed('b'));
	const c = await seed('c');
	await source.query('UPDATE backend_internal.work_item SET state=\'ready\',attempt_count=0,execution_owner=NULL,execution_until=NULL,execution_epoch=0 WHERE work_id=\'c\'');
	await expect(source.transaction(async manager => {
		await manager.query('UPDATE backend_internal.work_item SET state=\'running\',attempt_count=1,execution_owner=\'worker\',execution_until=clock_timestamp()+interval \'60 seconds\',execution_epoch=1 WHERE work_id=\'c\'');
		await store.acquire(manager, c);
	})).rejects.toThrow('slots unavailable');
	expect(await source.query('SELECT state,attempt_count,execution_epoch FROM backend_internal.work_item WHERE work_id=\'c\'')).toEqual([{ state: 'ready', attempt_count: 0, execution_epoch: '0' }]);
});

test.each(['rows', 'bytes'])('new host %s capacity failure rolls back rows and charge', async dimension => {
	const item = await seed('a');
	await source.query(dimension === 'rows' ? 'UPDATE backend_internal.work_capacity SET reserved_rows=899999' : 'UPDATE backend_internal.work_capacity SET reserved_bytes=19327351808');
	const before = await capacity();
	await expect(acquire(item)).rejects.toThrow('capacity');
	expect(await slots()).toEqual([]);
	expect(await capacity()).toEqual(before);
});

test('existing slots can be used above the normal creation threshold', async () => {
	const a = await seed('a');
	const lease = await acquire(a);
	await source.transaction(manager => store.release(manager, lease));
	const b = await seed('b');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=900001');
	const before = await capacity();
	expect(await acquire(b)).toMatchObject({ host: 'remote.test', slot: 0, hostEpoch: '2' });
	expect(await slots()).toHaveLength(2);
	expect(await capacity()).toEqual(before);
});

test('caller rollback leaves neither host rows nor their charge', async () => {
	const a = await seed('a');
	const before = await capacity();
	await expect(source.transaction(async manager => {
		await store.acquire(manager, a);
		throw new Error('rollback');
	})).rejects.toThrow('rollback');
	expect(await slots()).toEqual([]);
	expect(await capacity()).toEqual(before);
});

test('renewal follows a caller-renewed execution lease and release is idempotent', async () => {
	const a = await seed('a');
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()+interval \'20 seconds\' WHERE work_id=\'a\'');
	const lease = await acquire(a);
	const before = (await slots())[0].lease_until;
	await source.transaction(async manager => {
		await manager.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()+interval \'60 seconds\' WHERE work_id=\'a\'');
		await store.renew(manager, lease);
	});
	expect((await slots())[0].lease_until.getTime()).toBeGreaterThan(before.getTime() + 30000);
	expect(await source.transaction(manager => store.release(manager, lease))).toBe(true);
	expect(await source.transaction(manager => store.release(manager, lease))).toBe(false);
	await expect(source.transaction(manager => store.renew(manager, lease))).rejects.toThrow('lease');
});

test('expired slot is replaced with a new epoch and rejects old renew and release', async () => {
	const old = await acquire(await seed('a'));
	await source.query('UPDATE backend_internal.ap_host_lease SET lease_until=clock_timestamp()-interval \'1 second\' WHERE slot=0');
	const replacement = await acquire(await seed('b'));
	expect(replacement).toMatchObject({ host: old.host, slot: old.slot, hostEpoch: '2' });
	await expect(source.transaction(manager => store.renew(manager, old))).rejects.toThrow('lease');
	expect(await source.transaction(manager => store.release(manager, old))).toBe(false);
	expect((await slots())[0]).toMatchObject({ work_id: 'b', lease_id: replacement.token });
});

test('expired host lease cannot be revived by extending just the execution lease', async () => {
	const lease = await acquire(await seed('a'));
	await source.query('UPDATE backend_internal.ap_host_lease SET lease_until=clock_timestamp()-interval \'1 second\' WHERE slot=0');
	await expect(source.transaction(manager => store.renew(manager, lease))).rejects.toThrow('lease');
});

test('cleanup preserves active and pending references, then returns stored charges once', async () => {
	const lease = await acquire(await seed('a'));
	expect(await store.cleanup(source)).toBe(0);
	await age();
	expect(await store.cleanup(source)).toBe(0);
	await source.query('UPDATE backend_internal.work_item SET state=\'retry_wait\',execution_owner=NULL,execution_until=NULL WHERE work_id=\'a\'');
	expect(await store.cleanup(source)).toBe(0);
	await source.query('UPDATE backend_internal.work_item SET state=\'succeeded\',finished_at=clock_timestamp() WHERE work_id=\'a\'');
	expect(await store.cleanup(source)).toBe(0);
	await source.query('UPDATE backend_internal.work_item SET state=\'succeeded\',finished_at=clock_timestamp()-interval \'31 days\' WHERE work_id=\'a\'');
	// Stored charges, rather than today's formula, are the authority during cleanup.
	await source.query('UPDATE backend_internal.ap_host_lease SET charged_bytes=4096');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_bytes=reserved_bytes+4096');
	const before = await capacity();
	expect(await store.cleanup(source)).toBe(2);
	const after = await capacity();
	expect(BigInt(before.reserved_rows) - BigInt(after.reserved_rows)).toBe(2n);
	expect(BigInt(before.reserved_bytes) - BigInt(after.reserved_bytes)).toBe(8192n);
	expect(await store.cleanup(source)).toBe(0);
	const recreated = await acquire(await seed('b'));
	expect(recreated.token).not.toBe(lease.token);
	expect(await source.transaction(manager => store.release(manager, lease))).toBe(false);
});

test('cleanup limit is bounded and concurrent cleanup never subtracts twice', async () => {
	const lease = await acquire(await seed('a'));
	await source.transaction(manager => store.release(manager, lease));
	await source.query('UPDATE backend_internal.work_item SET state=\'succeeded\',finished_at=clock_timestamp()-interval \'31 days\' WHERE work_id=\'a\'');
	await age();
	const before = await capacity();
	const counts = await Promise.all([store.cleanup(source, 1), store.cleanup(source, 1)]);
	expect(counts).toEqual([1, 1]);
	expect(BigInt(before.reserved_rows) - BigInt((await capacity()).reserved_rows)).toBe(2n);
	await expect(store.cleanup(source, 101)).rejects.toThrow('batch');
});

test('acquisition recreates only the missing idle slot and charges exactly one row', async () => {
	const lease = await acquire(await seed('a'));
	await source.transaction(manager => store.release(manager, lease));
	await source.query('UPDATE backend_internal.work_item SET state=\'succeeded\',finished_at=clock_timestamp()-interval \'31 days\' WHERE work_id=\'a\'');
	await age();
	expect(await store.cleanup(source, 1)).toBe(1);
	const b = await seed('b');
	const before = await capacity();
	expect(await acquire(b)).toMatchObject({ slot: 0, hostEpoch: '1' });
	expect(await slots()).toHaveLength(2);
	const after = await capacity();
	expect(BigInt(after.reserved_rows) - BigInt(before.reserved_rows)).toBe(1n);
	expect(BigInt(after.reserved_bytes) - BigInt(before.reserved_bytes)).toBe(2048n);
	expect(await source.transaction(manager => store.release(manager, lease))).toBe(false);
});

test('renew cannot revive a host lease that expires while waiting for the slot lock', async () => {
	const lease = await acquire(await seed('a'));
	const blocker = source.createQueryRunner();
	await blocker.connect();
	await blocker.startTransaction();
	let pending: Promise<unknown> | undefined;
	try {
		await blocker.query('UPDATE backend_internal.ap_host_lease SET lease_until=clock_timestamp()+interval \'300 milliseconds\' WHERE slot=0');
		pending = source.transaction(manager => store.renew(manager, lease)).then(() => null, error => error);
		// The blocker holds the row longer than its new lease, without changing its ownership.
		await blocker.query('SELECT pg_sleep(0.4)');
		await blocker.commitTransaction();
		expect(await pending).toMatchObject({ message: 'Lost AP host lease' });
	} finally {
		if (blocker.isTransactionActive) {
			await blocker.rollbackTransaction();
		}
		await blocker.release();
		await pending;
	}
});

test('expired item is rejected after waiting for capacity even on repeated acquisition', async () => {
	const item = await seed('a');
	await acquire(item);
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()+interval \'300 milliseconds\' WHERE work_id=\'a\'');
	const blocker = source.createQueryRunner();
	await blocker.connect();
	await blocker.startTransaction();
	let pending: Promise<unknown> | undefined;
	try {
		await blocker.query('SELECT capacity_key FROM backend_internal.work_capacity WHERE capacity_key=\'global\' FOR UPDATE');
		pending = acquire(item).then(() => null, error => error);
		await blocker.query('SELECT pg_sleep(0.4)');
		await blocker.commitTransaction();
		expect(await pending).toMatchObject({ message: 'Lost AP host execution' });
	} finally {
		if (blocker.isTransactionActive) {
			await blocker.rollbackTransaction();
		}
		await blocker.release();
		await pending;
	}
});

test('all transaction-bound methods reject autocommit managers', async () => {
	const item = await seed('a');
	const lease = await acquire(item);
	await expect(store.acquire(source.manager, item)).rejects.toThrow('active transaction');
	await expect(store.renew(source.manager, lease)).rejects.toThrow('active transaction');
	await expect(store.release(source.manager, lease)).rejects.toThrow('active transaction');
});

test('new migration rolls host charges back without changing upstream history, and re-applies without drift', async () => {
	await acquire(await seed('a'));
	const before = await capacity();
	const upstream = await source.query('SELECT * FROM public.migrations ORDER BY id');
	const internal = migrationSources(database.config.database).internal;
	try {
		await internal.initialize();
		await internal.undoLastMigration();
		expect(await source.query('SELECT to_regclass(\'backend_internal.ap_host_lease\') AS name')).toEqual([{ name: null }]);
		expect(BigInt(before.reserved_rows) - BigInt((await capacity()).reserved_rows)).toBe(2n);
		expect(BigInt(before.reserved_bytes) - BigInt((await capacity()).reserved_bytes)).toBe(4096n);
		await internal.runMigrations();
	} finally {
		await internal.destroy();
	}
	expect(await source.query('SELECT * FROM public.migrations ORDER BY id')).toEqual(upstream);
	await assertSchemaMatches(database.config.database);
});
