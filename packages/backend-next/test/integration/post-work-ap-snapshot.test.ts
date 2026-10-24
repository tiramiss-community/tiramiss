/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiFollowing, MiRelay, MiUser } from 'backend-upstream/entities';
import { ApRecipientSnapshot1792734340852 } from '../../src/platform/database/ap/migration.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { PostWorkDispatchStore } from '../../src/platform/database/post-work/dispatch.js';
import { PostWorkLocalExecutionStore } from '../../src/platform/database/post-work/local-execution.js';
import { PostApRecipientSnapshot } from '../../src/platform/database/ap/snapshot.js';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import type { ApWorkRequest } from '../../src/modules/post-work/public.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
});
beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.ap_host_lease, backend_internal.delivery_recipient, backend_internal.notification, backend_internal.notification_effect, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.query('TRUNCATE public.following, public.relay, public.\"user\" CASCADE');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3, reserved_bytes=6144');
	await source.query('UPDATE backend_internal.work_control SET reserved_dispatches=0, paused=false, recovery_pending=false, queue_generation=1');
	await source.getRepository(MiUser).insert([{ id: 'actor', username: 'actor', usernameLower: 'actor' }, { id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test', inbox: 'https://remote.test/inbox', sharedInbox: 'https://remote.test/shared' }]);
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});
test('provides a durable recipient ledger without modifying upstream note tables', async () => {
	expect(await source.query('SELECT to_regclass(\'backend_internal.delivery_recipient\')::text AS ledger'))
		.toEqual([{ ledger: 'backend_internal.delivery_recipient' }]);
});

async function seed(visibility: ApWorkRequest['note']['visibility'] = 'public', localOnly = false, directActorIds = ['remote'], channelId: string | null = null, deleting = false) {
	const now = Date.now() - 1000;
	const request: ApWorkRequest = {
		requestId: 'request', eventId: 'event', noteId: 'note', actorId: 'actor',
		note: { visibility, localOnly, channelId }, noteGeneration: deleting ? 2 : 1,
		kind: 'ap.expand', schemaVersion: 1, occurredAtMs: now, notBeforeMs: now,
		payload: { activity: { id: 'https://local.test/activity', type: deleting ? 'Delete' : 'Create', body: JSON.stringify({ id: 'https://local.test/activity', type: deleting ? 'Delete' : 'Create' }) }, directActorIds },
	};
	await source.transaction(manager => withPostWorkRequests(manager, tx => tx.append(request)));
	const dispatch = await new PostWorkDispatchStore(source).claim('scanner');
	if (dispatch.status !== 'claimed') {
		throw new Error('Missing dispatch');
	}
	const owned = await new PostWorkLocalExecutionStore(source).claim({
		workId: dispatch.reservation.workId, kind: 'ap.expand', schemaVersion: 1,
		dispatchSeq: dispatch.reservation.dispatchSeq, queueGeneration: dispatch.reservation.queueGeneration,
	}, 'worker');
	if (!owned) {
		throw new Error('Missing claim');
	}
	return { owned, request };
}

const ledger = () => source.query('SELECT inbox,shared,send_state,activity_id FROM backend_internal.delivery_recipient ORDER BY inbox');
const items = () => source.query('SELECT kind,state,payload,deadline_at FROM backend_internal.work_item ORDER BY kind');
const capacity = () => source.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity');
const complete = (owned: Awaited<ReturnType<typeof seed>>['owned']) => source.transaction(manager => new PostApRecipientSnapshot().complete(manager, owned, async () => ({ status: 'deliver' })));

const coverage = () => source.query('SELECT recipient_coverage FROM backend_internal.note_work_state');

async function expectUnchangedExpansion(beforeCoverage: unknown) {
	expect(await items()).toEqual([expect.objectContaining({ kind: 'ap.expand', state: 'running' })]);
	expect(await coverage()).toEqual(beforeCoverage);
}

async function follow() {
	await source.getRepository(MiFollowing).insert({ id: 'follow', followeeId: 'actor', followerId: 'remote', followerHost: 'remote.test', followerInbox: 'https://remote.test/inbox', followerSharedInbox: 'https://remote.test/shared' });
}

test('fixes follower shared inbox, deduplicates direct and stores accepted public relay with the first page', async () => {
	await follow();
	await source.getRepository(MiRelay).insert([{ id: 'relay', inbox: 'https://relay.test/inbox', status: 'accepted' }, { id: 'pending', inbox: 'https://pending.test/inbox', status: 'requesting' }]);
	const { owned } = await seed();
	expect(await complete(owned)).toEqual({ count: 2 });
	expect(await ledger()).toEqual([
		{ inbox: 'https://relay.test/inbox', shared: false, send_state: 'pending', activity_id: 'https://local.test/activity' },
		{ inbox: 'https://remote.test/shared', shared: true, send_state: 'pending', activity_id: 'https://local.test/activity' },
	]);
	expect(await items()).toMatchObject([{ kind: 'ap.expand', state: 'succeeded' }, { kind: 'ap.expand.page', state: 'ready', payload: '{"after":null}' }]);
	const rows = await items();
	expect(rows[1].deadline_at).toEqual(rows[0].deadline_at);
	expect(await source.query('SELECT recipient_coverage FROM backend_internal.note_work_state')).toEqual([{ recipient_coverage: 'fixed' }]);
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'open' }]);
});

test.each(['home', 'followers', 'specified'] as const)('%s limits the follower/relay recipe', async visibility => {
	await follow();
	await source.getRepository(MiRelay).insert({ id: 'relay', inbox: 'https://relay.test/inbox', status: 'accepted' });
	const { owned } = await seed(visibility);
	await complete(owned);
	expect((await ledger()).map((row: { inbox: string }) => row.inbox)).toEqual([visibility === 'specified' ? 'https://remote.test/inbox' : 'https://remote.test/shared']);
});

test.each(['localOnly', 'channel', 'suppressed', 'empty'] as const)('%s fixes an empty set without a page', async condition => {
	await follow();
	const { owned } = await seed('public', condition === 'localOnly' || condition === 'channel', condition === 'empty' ? [] : ['remote'], condition === 'channel' ? 'channel' : null);
	if (condition === 'empty') {
		await source.getRepository(MiFollowing).deleteAll();
	}
	const before = await capacity();
	await source.transaction(manager => new PostApRecipientSnapshot().complete(manager, owned, async () => condition === 'suppressed' ? { status: 'suppress', reason: 'federation_disabled' } : { status: 'deliver' }));
	expect(await ledger()).toEqual([]);
	expect(await items()).toHaveLength(1);
	expect(await capacity()).toEqual(before);
	expect(await source.query('SELECT recipient_coverage,recipients_fixed_at IS NOT NULL AS fixed FROM backend_internal.note_work_state'))
		.toEqual([{ recipient_coverage: 'fixed', fixed: true }]);
});

test('uses denormalized follower endpoints and falls back to a personal inbox', async () => {
	await follow();
	await source.getRepository(MiFollowing).update({ id: 'follow' }, { followerSharedInbox: null, followerInbox: 'https://old.test/inbox' });
	const { owned } = await seed('home', false, []);
	await complete(owned);
	expect(await ledger()).toMatchObject([{ inbox: 'https://old.test/inbox', shared: false }]);
});

test('does not deliver to local direct actors', async () => {
	const { owned } = await seed('specified', false, ['actor']);
	expect(await complete(owned)).toEqual({ count: 0 });
});

test.each(['missing_direct', 'missing_inbox', 'missing_follower_inbox'] as const)('%s rolls back instead of discarding a recipient', async condition => {
	await follow();
	const { owned } = await seed('public', false, condition === 'missing_direct' ? ['absent'] : ['remote']);
	if (condition === 'missing_inbox') {
		await source.getRepository(MiUser).update({ id: 'remote' }, { inbox: null });
	}
	if (condition === 'missing_follower_inbox') {
		await source.getRepository(MiFollowing).update({ id: 'follow' }, { followerInbox: null, followerSharedInbox: null });
	}
	const before = await capacity();
	const beforeCoverage = await coverage();
	await expect(complete(owned)).rejects.toThrow('Unresolved');
	expect(await ledger()).toEqual([]);
	expect(await capacity()).toEqual(before);

	await expectUnchangedExpansion(beforeCoverage);
});

test('rollback after completion removes the entire fixed set and page', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await expect(source.transaction(async manager => {
		await new PostApRecipientSnapshot().complete(manager, owned, async () => ({ status: 'deliver' }));
		throw new Error('before commit');
	})).rejects.toThrow('before commit');
	expect(await ledger()).toEqual([]);
	expect(await items()).toMatchObject([{ kind: 'ap.expand', state: 'running' }]);
	expect(await capacity()).toEqual(before);
	expect(await source.query('SELECT recipient_coverage FROM backend_internal.note_work_state')).toEqual([{ recipient_coverage: 'not_started' }]);
});

test.each(['rows', 'bytes'] as const)('capacity %s failure rolls back recipients and page', async dimension => {
	const { owned } = await seed();
	await source.query(dimension === 'rows' ? 'UPDATE backend_internal.work_capacity SET reserved_rows=900000' : 'UPDATE backend_internal.work_capacity SET reserved_bytes=19327352832');
	const before = await capacity();
	await expect(complete(owned)).rejects.toThrow('capacity');
	expect(await ledger()).toEqual([]);
	expect(await items()).toHaveLength(1);
	expect(await capacity()).toEqual(before);
});

test.each(['owner', 'epoch', 'lease', 'deadline', 'cancel'] as const)('%s fences all writes', async change => {
	const { owned } = await seed();
	if (change === 'owner') {
		owned.owner = 'obsolete';
	} else if (change === 'epoch') {
		owned.epoch = '999';
	} else if (change === 'lease') {
		await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\'');
	} else if (change === 'deadline') {
		await source.query('UPDATE backend_internal.work_item SET deadline_at=clock_timestamp()-interval \'1 second\'');
	} else {
		await source.query('UPDATE backend_internal.note_work_state SET generation=2,deleted_at=clock_timestamp(),cancel_event_id=\'deleted\'');
	}
	const beforeCoverage = await coverage();
	await expect(complete(owned)).rejects.toThrow('execution');
	expect(await ledger()).toEqual([]);
	await expectUnchangedExpansion(beforeCoverage);
});

test('lease loss during federation checking rolls back the generated set', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await expect(source.transaction(manager => new PostApRecipientSnapshot().complete(manager, owned, async () => {
		await manager.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\'');
		return { status: 'deliver' };
	}))).rejects.toThrow('execution');
	expect(await ledger()).toEqual([]);
	expect(await items()).toHaveLength(1);
	expect(await capacity()).toEqual(before);
});

test('parallel completion fixes one set and page', async () => {
	const { owned } = await seed();
	const results = await Promise.allSettled([complete(owned), complete(owned)]);
	expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
	expect(await ledger()).toHaveLength(1);
	expect(await items()).toHaveLength(2);
});

test('saved payload corruption is rejected even when caller payload looks valid', async () => {
	const { owned } = await seed();
	await source.query('UPDATE backend_internal.work_request SET payload=replace(payload,\'remote\',\'absent\')');
	const beforeCoverage = await coverage();
	await expect(complete(owned)).rejects.toThrow('payload');
	expect(await ledger()).toEqual([]);
	await expectUnchangedExpansion(beforeCoverage);
});

test('caller mutation during recheck does not redirect the completion', async () => {
	const { owned } = await seed();
	await source.transaction(manager => new PostApRecipientSnapshot().complete(manager, owned, async () => {
		owned.workId = 'other';
		owned.requestId = 'other';
		return { status: 'deliver' };
	}));
	expect(await ledger()).toHaveLength(1);
	expect((await items())[0].state).toBe('succeeded');
});

test('a lost commit acknowledgement can be resolved after reconnect without rebuilding the fixed set', async () => {
	await follow();
	const { owned } = await seed();
	const runner = source.createQueryRunner();
	try {
		await runner.connect();
		await runner.startTransaction();
		await new PostApRecipientSnapshot().complete(runner.manager, owned, async () => ({ status: 'deliver' }));
		// Another connection cannot observe a partial set, page, or coverage before COMMIT.
		expect(await ledger()).toEqual([]);
		expect(await items()).toHaveLength(1);
		await expect((async () => {
			await runner.commitTransaction();
			throw new Error('commit acknowledgement lost');
		})()).rejects.toThrow('commit acknowledgement lost');
	} finally {
		try {
			if (runner.isTransactionActive) {
				await runner.rollbackTransaction();
			}
		} finally {
			await runner.release();
		}
	}
	await source.getRepository(MiFollowing).deleteAll();
	await source.getRepository(MiUser).update({ id: 'remote' }, { inbox: 'https://new.test/inbox', sharedInbox: 'https://new.test/shared' });
	await expect(complete(owned)).rejects.toThrow('execution');
	const reconnected = await createDataSource(database.config.database).initialize();
	try {
		expect(await reconnected.query('SELECT inbox FROM backend_internal.delivery_recipient')).toEqual([{ inbox: 'https://remote.test/shared' }]);
	} finally {
		await reconnected.destroy();
	}
});

test('charges recipients and page and retains the set for 90 days', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await complete(owned);
	const [saved] = await source.query('SELECT charged_bytes,retain_until-fixed_at AS retention FROM backend_internal.delivery_recipient');
	expect(saved.charged_bytes).toBe('3072');
	expect(saved.retention.days).toBe(90);
	const after = await capacity();
	expect(BigInt(after[0].reserved_rows) - BigInt(before[0].reserved_rows)).toBe(2n);
	expect(BigInt(after[0].reserved_bytes) - BigInt(before[0].reserved_bytes)).toBe(10240n);
});

test('respects a shorter statement timeout and restores the original setting', async () => {
	const { owned } = await seed();
	await source.transaction(async manager => {
		await manager.query('SET LOCAL statement_timeout=\'3s\'');
		await new PostApRecipientSnapshot().complete(manager, owned, async () => ({ status: 'deliver' }));
		expect(await manager.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '3s' }]);
	});
});

test('requires an active caller-owned transaction', async () => {
	const { owned } = await seed();
	await expect(new PostApRecipientSnapshot().complete(source.manager, owned, async () => ({ status: 'deliver' }))).rejects.toThrow('active transaction');
});

test('more than 200000 distinct destinations is an explicit failure without a partial ledger or page', async () => {
	const { owned } = await seed('public', false, []);
	await source.query(`INSERT INTO public.relay (id,inbox,status)
		SELECT 'r'||i,'https://relay.test/inbox/'||i,'accepted' FROM generate_series(1,200001) i`);
	const before = await capacity();
	await complete(owned);
	expect(await ledger()).toEqual([]);
	expect(await items()).toMatchObject([{ kind: 'ap.expand', state: 'failed_permanent' }]);
	expect(await source.query('SELECT reason_code FROM backend_internal.work_item')).toEqual([{ reason_code: 'recipient_limit' }]);
	expect(await source.query('SELECT recipient_coverage FROM backend_internal.note_work_state')).toEqual([{ recipient_coverage: 'unavailable' }]);
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'needs_attention' }]);
	expect(await capacity()).toEqual(before);
});

test('followers, relay and direct changes during insertion do not mix snapshots', async () => {
	await follow();
	await source.getRepository(MiRelay).insert({ id: 'relay', inbox: 'https://relay.test/old', status: 'accepted' });
	await source.getRepository(MiUser).insert({ id: 'direct', username: 'direct', usernameLower: 'direct', host: 'direct.test', inbox: 'https://direct.test/old' });
	const { owned } = await seed('public', false, ['direct']);
	await source.query(`CREATE FUNCTION public.block_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_advisory_xact_lock(1792734,1); RETURN NEW; END $$`);
	await source.query('CREATE TRIGGER block_recipient BEFORE INSERT ON backend_internal.delivery_recipient FOR EACH ROW EXECUTE FUNCTION public.block_recipient()');
	const blocker = source.createQueryRunner();
	await blocker.connect();
	await blocker.query('SELECT pg_advisory_lock(1792734,1)');
	const pending = complete(owned);
	let finished = false;
	void pending.then(() => {
		finished = true;
	}, () => {
		finished = true;
	});
	try {
		let waiting = false;
		for (let step = 0; step < 100 && !finished; step++) {
			const [state] = await source.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event=\'advisory\') AS waiting');
			if (state.waiting) {
				waiting = true;
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		expect(waiting).toBe(true);
		await source.getRepository(MiFollowing).update({ id: 'follow' }, { followerSharedInbox: 'https://remote.test/new' });
		await source.getRepository(MiRelay).update({ id: 'relay' }, { inbox: 'https://relay.test/new' });
		await source.getRepository(MiUser).update({ id: 'direct' }, { inbox: 'https://direct.test/new' });
	} finally {
		await blocker.query('SELECT pg_advisory_unlock(1792734,1)');
		await blocker.release();
		await pending;
		await source.query('DROP TRIGGER block_recipient ON backend_internal.delivery_recipient');
		await source.query('DROP FUNCTION public.block_recipient()');
	}
	expect((await ledger()).map((row: { inbox: string }) => row.inbox)).toEqual(['https://direct.test/old', 'https://relay.test/old', 'https://remote.test/shared']);
});

test('empty completion can settle while deletion reservations exceed the normal creation limit', async () => {
	const { owned } = await seed('public', true);
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=900001');
	const before = await capacity();
	expect(await complete(owned)).toEqual({ count: 0 });
	expect((await items())[0].state).toBe('succeeded');
	expect(await capacity()).toEqual(before);
});

test('Delete requests are not expanded using creation recipes', async () => {
	const { owned } = await seed('public', false, ['remote'], null, true);
	const before = await capacity();
	const beforeCoverage = await coverage();
	await expect(complete(owned)).rejects.toThrow('unsupported');
	expect(await ledger()).toEqual([]);

	expect(await capacity()).toEqual(before);
	await expectUnchangedExpansion(beforeCoverage);
});

test('a real SQL timeout rolls back the entire snapshot', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await source.query(`CREATE FUNCTION public.slow_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`);
	await source.query('CREATE TRIGGER slow_recipient BEFORE INSERT ON backend_internal.delivery_recipient FOR EACH ROW EXECUTE FUNCTION public.slow_recipient()');
	try {
		await expect(source.transaction(async manager => {
			await manager.query('SET LOCAL statement_timeout=\'50ms\'');
			await new PostApRecipientSnapshot().complete(manager, owned, async () => ({ status: 'deliver' }));
		})).rejects.toMatchObject({ driverError: { code: '57014' } });
	} finally {
		await source.query('DROP TRIGGER slow_recipient ON backend_internal.delivery_recipient');
		await source.query('DROP FUNCTION public.slow_recipient()');
	}
	expect(await ledger()).toEqual([]);
	expect(await items()).toHaveLength(1);
	expect(await capacity()).toEqual(before);
});

test('migration down releases saved ledger charges and up restores the exact schema', async () => {
	const { owned } = await seed();
	await complete(owned);
	const before = await capacity();
	await source.transaction(async manager => {
		const runner = manager.queryRunner!;
		await new ApRecipientSnapshot1792734340852().down(runner);
		const after = await manager.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity');
		expect(BigInt(before[0].reserved_rows) - BigInt(after[0].reserved_rows)).toBe(1n);
		expect(BigInt(before[0].reserved_bytes) - BigInt(after[0].reserved_bytes)).toBe(3072n);
		await new ApRecipientSnapshot1792734340852().up(runner);
	});
	await assertSchemaMatches(database.config.database);
});

test('applies the 20s snapshot limit and restores a longer caller timeout', async () => {
	const { owned } = await seed();
	await source.query(`CREATE FUNCTION public.check_snapshot_timeout() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF current_setting('statement_timeout') <> '20s' THEN
				RAISE EXCEPTION 'snapshot timeout was not capped';
			END IF;
			RETURN NEW;
		END $$`);
	await source.query('CREATE TRIGGER check_snapshot_timeout BEFORE INSERT ON backend_internal.delivery_recipient FOR EACH ROW EXECUTE FUNCTION public.check_snapshot_timeout()');
	try {
		await source.transaction(async manager => {
			await manager.query('SET LOCAL statement_timeout=\'30s\'');
			await new PostApRecipientSnapshot().complete(manager, owned, async () => ({ status: 'deliver' }));
			expect(await manager.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '30s' }]);
		});
	} finally {
		await source.query('DROP TRIGGER check_snapshot_timeout ON backend_internal.delivery_recipient');
		await source.query('DROP FUNCTION public.check_snapshot_timeout()');
	}
	expect(await ledger()).toHaveLength(1);
});
