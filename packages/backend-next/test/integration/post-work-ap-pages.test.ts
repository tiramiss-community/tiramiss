/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiRelay, MiUser } from 'backend-upstream/entities';
import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { PostWorkDispatchStore } from '../../src/platform/database/post-work/dispatch.js';
import { PostWorkLocalExecutionStore } from '../../src/platform/database/post-work/local-execution.js';
import { PostApRecipientSnapshot } from '../../src/platform/database/ap/snapshot.js';
import { PostApRecipientPages } from '../../src/platform/database/ap/pages.js';
import { workHash } from '../../src/modules/post-work/prepare.js';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';
import { apRequest } from '../helpers/post-work.js';
import type { LocalExecutionClaim, LocalExecutionEnvelope } from '../../src/platform/jobs/local-execution.js';
import type { DataSource } from 'typeorm';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let execution: PostWorkLocalExecutionStore;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	execution = new PostWorkLocalExecutionStore(source, () => 0);
});
beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.ap_host_lease, backend_internal.delivery_recipient, backend_internal.notification, backend_internal.notification_effect, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.query('TRUNCATE public.following, public.relay, public."user" CASCADE');
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3,reserved_bytes=6144');
	await source.query('UPDATE backend_internal.work_control SET reserved_dispatches=0,paused=false,recovery_pending=false,queue_generation=1');
	await source.getRepository(MiUser).insert({ id: 'actor', username: 'actor', usernameLower: 'actor' });
});
afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

async function envelope(): Promise<LocalExecutionEnvelope> {
	// Send execution is a later slice: keep those fixtures out of the scanner's ready candidates.
	await source.query('UPDATE backend_internal.work_item SET next_attempt_at=deadline_at WHERE kind=\'ap.send\'');
	const result = await new PostWorkDispatchStore(source).claim('scanner');
	if (result.status !== 'claimed') {
		throw new Error('Missing dispatch');
	}
	const { workId, kind, schemaVersion, dispatchSeq, queueGeneration } = result.reservation;
	return { workId, kind, schemaVersion, dispatchSeq, queueGeneration };
}

async function claim(input = envelope()): Promise<LocalExecutionClaim> {
	const owned = await execution.claim(await input, 'worker');
	if (!owned) {
		throw new Error('Missing claim');
	}
	return owned;
}

async function seed(count: number, extra: string[] = []) {
	if (extra.length) {
		await source.getRepository(MiRelay).insert(extra.map((inbox, i) => ({ id: `extra${i}`, inbox, status: 'accepted' })));
	}
	if (count > 0) {
		await source.query(`INSERT INTO public.relay (id,inbox,status)
			SELECT 'r'||i,'https://relay.test/'||lpad(i::text,4,'0'),'accepted' FROM generate_series(1,$1::integer) i`, [count]);
	}
	const request = apRequest();
	request.occurredAtMs = Date.now() - 1000;
	request.notBeforeMs = request.occurredAtMs;
	await source.transaction(manager => withPostWorkRequests(manager, tx => tx.append(request)));
	const root = await claim();
	await source.transaction(manager => new PostApRecipientSnapshot().complete(manager, root, async () => ({ status: 'deliver' })));
	return request;
}

const complete = (owned: LocalExecutionClaim) => source.transaction(manager => new PostApRecipientPages().complete(manager, owned));
const children = () => source.query('SELECT * FROM backend_internal.work_item WHERE kind=\'ap.send\' ORDER BY target_key');
const pages = () => source.query('SELECT * FROM backend_internal.work_item WHERE kind=\'ap.expand.page\' ORDER BY target_key');
const capacity = () => source.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity');

// Removing the 100-recipient bound or creating a next page without a remainder breaks these boundaries.
test.each([1, 100, 101])('%i recipients creates at most 100 sends and only a necessary next page', async count => {
	const request = await seed(count);
	const owned = await claim();
	const before = await capacity();
	expect(await complete(owned)).toEqual({ count: Math.min(count, 100) });
	const sends = await children();
	expect(sends).toHaveLength(Math.min(count, 100));
	expect(sends[0]).toMatchObject({ request_id: 'request', target_key: 'https://relay.test/0001', payload: '{"inbox":"https://relay.test/0001","shared":false}', state: 'ready', attempt_count: 0, charged_bytes: '7168', deadline_at: new Date(request.notBeforeMs + 86400000), next_attempt_at: new Date(request.notBeforeMs) });
	expect(sends.some((item: { payload: string }) => item.payload.includes('hello'))).toBe(false);
	const savedPages = await pages();
	expect(savedPages).toHaveLength(count > 100 ? 2 : 1);
	expect(savedPages.find((item: { target_key: string }) => item.target_key === 'start')).toMatchObject({ state: 'succeeded', attempt_count: 1 });
	if (count > 100) {
		expect(savedPages.find((item: { target_key: string }) => item.target_key !== 'start')).toMatchObject({ state: 'ready', payload: JSON.stringify({ after: 'https://relay.test/0100', previous: owned.workId }), deadline_at: new Date(request.notBeforeMs + 86400000), attempt_count: 0 });
	}
	const after = await capacity();
	expect(BigInt(after[0].reserved_rows) - BigInt(before[0].reserved_rows)).toBe(BigInt(Math.min(count, 100) + (count > 100 ? 1 : 0)));
	expect(BigInt(after[0].reserved_bytes) - BigInt(before[0].reserved_bytes)).toBe(count > 100 ? 724992n : BigInt(count * 7168));
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'open' }]);
	expect(await source.query('SELECT DISTINCT send_state FROM backend_internal.delivery_recipient')).toEqual([{ send_state: 'pending' }]);
});

test('empty fixed set has no page to execute', async () => {
	await seed(0);
	expect(await pages()).toEqual([]);
	expect(await children()).toEqual([]);
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'settled' }]);
});

test('1101 recipients continue in twelve independent first attempts using only the fixed set', async () => {
	const request = await seed(1101);
	await source.getRepository(MiRelay).deleteAll();
	await source.getRepository(MiRelay).insert({ id: 'new', inbox: 'https://new.test/inbox', status: 'accepted' });
	for (let i = 0; i < 12; i++) {
		await complete(await claim());
	}
	const sends = await children();
	expect(sends).toHaveLength(1101);
	expect(new Set(sends.map((item: { target_key: string }) => item.target_key)).size).toBe(1101);
	expect(sends.at(-1).target_key).toBe('https://relay.test/1101');
	expect(await source.query('SELECT DISTINCT attempt_count,state,deadline_at FROM backend_internal.work_item WHERE kind=\'ap.expand.page\''))
		.toEqual([{ attempt_count: 1, state: 'succeeded', deadline_at: new Date(request.notBeforeMs + 86400000) }]);
});

test('failed page rolls back children, continuation, quota and success, then resumes without rebuilding earlier pages', async () => {
	await seed(201);
	await complete(await claim());
	const owned = await claim();
	const before = await capacity();
	await expect(source.transaction(async manager => {
		await new PostApRecipientPages().complete(manager, owned);
		throw new Error('before commit');
	})).rejects.toThrow('before commit');
	expect(await capacity()).toEqual(before);
	expect(await children()).toHaveLength(100);
	expect(await pages()).toHaveLength(2);
	await execution.finish(owned, { status: 'retry', reason: 'test_failure' });
	await source.query('UPDATE backend_internal.work_item SET next_attempt_at=clock_timestamp()-interval \'1 second\',last_enqueued_at=NULL,dispatch_until=NULL,dispatch_owner=NULL WHERE work_id=$1', [owned.workId]);
	await source.query('UPDATE backend_internal.queue_dispatch SET state=\'released\',released_at=clock_timestamp() WHERE work_id=$1', [owned.workId]);
	const retry = await claim();
	expect(retry.attempt).toBe(2);
	await complete(retry);
	await complete(await claim());
	expect(await children()).toHaveLength(201);
	expect(await source.query('SELECT attempt_count FROM backend_internal.work_item WHERE kind=\'ap.expand.page\' ORDER BY target_key'))
		.toEqual(expect.arrayContaining([{ attempt_count: 1 }, { attempt_count: 2 }]));
});

test.each(['rows', 'bytes'])('capacity %s failure leaves no page effects', async dimension => {
	await seed(101);
	const owned = await claim();
	await source.query(dimension === 'rows' ? 'UPDATE backend_internal.work_capacity SET reserved_rows=900000' : 'UPDATE backend_internal.work_capacity SET reserved_bytes=19327352832');
	const before = await capacity();
	await expect(complete(owned)).rejects.toThrow('capacity');
	expect(await capacity()).toEqual(before);
	expect(await children()).toEqual([]);
	expect(await pages()).toMatchObject([{ state: 'running' }]);
});

test.each(['owner', 'epoch', 'lease', 'deadline', 'cancel'])('%s fences child generation', async change => {
	await seed(101);
	const owned = await claim();
	if (change === 'owner' || change === 'epoch') {
		owned[change] = 'obsolete';
	} else if (change === 'cancel') {
		await source.query('UPDATE backend_internal.note_work_state SET generation=2,deleted_at=clock_timestamp(),cancel_event_id=\'cancel\'');
	} else {
		await source.query(`UPDATE backend_internal.work_item SET ${change === 'lease' ? 'execution_until' : 'deadline_at'}=clock_timestamp()-interval '1 second' WHERE work_id=$1`, [owned.workId]);
	}
	await expect(complete(owned)).rejects.toThrow();
	expect(await children()).toEqual([]);
	expect(await pages()).toHaveLength(1);
});

test('lease loss during insertion rolls back child generation and quota', async () => {
	await seed(101);
	const owned = await claim();
	const before = await capacity();
	await source.query(`CREATE FUNCTION expire_page_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.kind='ap.send' THEN UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval '1 second' WHERE kind='ap.expand.page' AND state='running'; END IF;
		RETURN NEW; END $$`);
	await source.query('CREATE TRIGGER expire_page_lease BEFORE INSERT ON backend_internal.work_item FOR EACH ROW EXECUTE FUNCTION expire_page_lease()');
	try {
		await expect(complete(owned)).rejects.toThrow('execution');
		expect(await children()).toEqual([]);
		expect(await capacity()).toEqual(before);
	} finally {
		await source.query('DROP TRIGGER expire_page_lease ON backend_internal.work_item');
		await source.query('DROP FUNCTION expire_page_lease()');
	}
});

test('parallel completions commit one batch and reject duplicate terminal execution', async () => {
	await seed(101);
	const owned = await claim();
	const outcomes = await Promise.allSettled([complete(owned), complete(owned)]);
	expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
	expect(await children()).toHaveLength(100);
	expect(await pages()).toHaveLength(2);
	await expect(complete(owned)).rejects.toThrow('execution');
});

test.each(['deliver', 'postLocal'])('%s pause blocks page execution without consuming attempts', async queue => {
	await seed(1);
	const input = await envelope();
	await source.query('UPDATE backend_internal.work_control SET paused=true WHERE queue_key=$1', [queue]);
	expect(await execution.claim(input, 'worker')).toBe(null);
	expect(await pages()).toMatchObject([{ state: 'retry_wait', attempt_count: 0, reason_code: 'paused' }]);
	expect(await children()).toEqual([]);
});

test.each(['hash', 'version', 'deadline', 'cursor', 'root', 'coverage'])('invalid %s is quarantined before page execution', async change => {
	await seed(101);
	const input = await envelope();
	if (change === 'hash') {
		await source.query('UPDATE backend_internal.work_item SET payload_hash=$1 WHERE work_id=$2', ['0'.repeat(64), input.workId]);
	} else if (change === 'version') {
		await source.query('UPDATE backend_internal.work_item SET schema_version=2 WHERE work_id=$1', [input.workId]);
		input.schemaVersion = 2;
	} else if (change === 'deadline') {
		await source.query('UPDATE backend_internal.work_item SET deadline_at=deadline_at+interval \'1 second\' WHERE work_id=$1', [input.workId]);
	} else if (change === 'cursor') {
		const payload = '{"after":"https://relay.test/0050"}';
		await source.query('UPDATE backend_internal.work_item SET payload=$1,payload_hash=$2 WHERE work_id=$3', [payload, workHash(payload), input.workId]);
	} else if (change === 'root') {
		await source.query('UPDATE backend_internal.work_item SET state=\'retry_wait\' WHERE kind=\'ap.expand\'');
	} else {
		await source.query('UPDATE backend_internal.note_work_state SET recipient_coverage=\'expired\'');
	}
	expect(await execution.claim(input, 'worker')).toBe(null);
	expect(await pages()).toMatchObject([{ state: 'quarantined', attempt_count: 0 }]);
	expect(await children()).toEqual([]);
});

test('an existing cursor outside the preceding page boundary cannot skip recipients', async () => {
	await seed(201);
	await complete(await claim());
	const input = await envelope();
	const [page] = (await pages()).filter((item: { state: string }) => item.state === 'ready');
	const payload = JSON.stringify({ after: 'https://relay.test/0150', previous: JSON.parse(page.payload).previous });
	const target = 'after:' + workHash('https://relay.test/0150');
	const forgedId = workHash(JSON.stringify(['request', 'ap.expand.page', target]));
	await source.query('DELETE FROM backend_internal.queue_dispatch WHERE work_id=$1', [input.workId]);
	await source.query('UPDATE backend_internal.work_item SET work_id=$1,target_key=$2,payload=$3,payload_hash=$4 WHERE work_id=$5', [forgedId, target, payload, workHash(payload), input.workId]);
	// Redis has not been invoked: issue an authenticated dispatch for the forged fixture.
	await source.query('UPDATE backend_internal.work_item SET dispatch_owner=NULL,dispatch_until=NULL WHERE work_id=$1', [forgedId]);
	const forgedEnvelope = await envelope();
	expect(await execution.claim(forgedEnvelope, 'worker')).toBe(null);
	expect(await children()).toHaveLength(100);
	expect((await pages()).find((item: { work_id: string }) => item.work_id === forgedId)).toMatchObject({ state: 'quarantined' });
});

test.each(['request', 'event', 'actor', 'activity', 'note'])('ledger %s mismatch rejects completion without generating sends', async field => {
	await seed(1);
	const owned = await claim();
	const column = { request: 'request_id', event: 'create_event_id', actor: 'actor_id', activity: 'activity_id', note: 'note_id' }[field];
	if (field === 'request') {
		// Keep the FK valid while making the row belong to another request.
		await source.query(`INSERT INTO backend_internal.work_request SELECT 'other',event_id||'other',note_id,actor_id,note_generation,kind,schema_version,note_facts,payload,payload_hash,occurred_at,not_before,deadline_at,state,finished_at,capacity_formula_version,charged_bytes FROM backend_internal.work_request`);
	}
	await source.query(`UPDATE backend_internal.delivery_recipient SET ${column}='other'`);
	await expect(complete(owned)).rejects.toThrow();
	expect(await children()).toEqual([]);
	expect(await pages()).toMatchObject([{ state: 'running' }]);
});

test('saved page corruption after claim cannot be hidden by caller payload', async () => {
	await seed(101);
	const owned = await claim();
	await source.query('UPDATE backend_internal.work_item SET payload=\'{}\' WHERE work_id=$1', [owned.workId]);
	await expect(complete(owned)).rejects.toThrow('payload');
	expect(await children()).toEqual([]);
});

test('commit acknowledgement loss is resolved after reconnect and never regenerates a successful page', async () => {
	await seed(101);
	const owned = await claim();
	const runner = source.createQueryRunner();
	try {
		await runner.connect();
		await runner.startTransaction();
		await new PostApRecipientPages().complete(runner.manager, owned);
		expect(await children()).toEqual([]);
		expect(await pages()).toHaveLength(1);
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
	const reconnected = await createDataSource(database.config.database).initialize();
	try {
		expect(await reconnected.query('SELECT count(*)::int AS count FROM backend_internal.work_item WHERE kind=\'ap.send\'' )).toEqual([{ count: 100 }]);
		expect(await reconnected.query('SELECT state FROM backend_internal.work_item WHERE work_id=$1', [owned.workId])).toEqual([{ state: 'succeeded' }]);
	} finally {
		await reconnected.destroy();
	}
	await expect(complete(owned)).rejects.toThrow('execution');
	await complete(await claim());
	expect(await children()).toHaveLength(101);
});

test('requires the caller transaction', async () => {
	await seed(1);
	await expect(new PostApRecipientPages().complete(source.manager, await claim())).rejects.toThrow('active transaction');
});

test('a literal start inbox cannot collide with the initial page target', async () => {
	await seed(99, ['start', 'zz']);
	await complete(await claim());
	expect(await pages()).toHaveLength(2);
	const continuation = (await pages()).find((item: { state: string }) => item.state === 'ready');
	expect(JSON.parse(continuation.payload).after).toBe('start');
	expect(continuation.target_key).not.toBe('start');
	await complete(await claim());
	expect(await children()).toHaveLength(101);
});

test('2048 UTF-8 byte inboxes remain exact while continuation keys stay within the schema limit', async () => {
	const prefix = 'https://relay.test/' + '界'.repeat(670);
	const inboxes = Array.from({ length: 101 }, (_, i) => prefix + 'x'.repeat(2048 - Buffer.byteLength(prefix) - 4) + String(i).padStart(4, '0'));
	await seed(101);
	// Exercise the ledger schema limit independently of the upstream relay's shorter URL column.
	await source.transaction(async manager => {
		for (let i = 0; i < inboxes.length; i++) {
			await manager.createQueryBuilder().update('backend_internal.delivery_recipient').set({ inbox: inboxes[i] })
				.where('inbox=:old', { old: `https://relay.test/${String(i + 1).padStart(4, '0')}` }).execute();
		}
	});
	await complete(await claim());
	const continuation = (await pages()).find((item: { state: string }) => item.state === 'ready');
	expect(Buffer.byteLength(JSON.parse(continuation.payload).after)).toBe(2048);
	expect(Buffer.byteLength(continuation.target_key)).toBeLessThan(2048);
	await complete(await claim());
	expect((await children()).map((item: { target_key: string }) => item.target_key)).toEqual(inboxes);
});

test('shared delivery flags are copied from the fixed ledger', async () => {
	await seed(1);
	await source.query('UPDATE backend_internal.delivery_recipient SET shared=true');
	await complete(await claim());
	expect(await children()).toMatchObject([{ payload: '{"inbox":"https://relay.test/0001","shared":true}' }]);
});

test.each(['missing', 'root', 'unfinished'])('a %s predecessor does not authorize a continuation page', async change => {
	await seed(101);
	await complete(await claim());
	const input = await envelope();
	const [current] = (await pages()).filter((item: { state: string }) => item.state === 'ready');
	const payload = JSON.parse(current.payload);
	if (change === 'missing') {
		payload.previous = 'f'.repeat(64);
	} else if (change === 'root') {
		payload.previous = workHash(JSON.stringify(['request', 'ap.expand', 'all']));
	} else {
		await source.query('UPDATE backend_internal.work_item SET state=\'retry_wait\' WHERE work_id=$1', [payload.previous]);
	}
	const text = JSON.stringify(payload);
	await source.query('UPDATE backend_internal.work_item SET payload=$1,payload_hash=$2 WHERE work_id=$3', [text, workHash(text), current.work_id]);
	expect(await execution.claim(input, 'worker')).toBe(null);
	expect(await children()).toHaveLength(100);
	expect((await pages()).find((item: { work_id: string }) => item.work_id === current.work_id)).toMatchObject({ state: 'quarantined', attempt_count: 0 });
});

test('page leases renew and exhausted pages terminate without generating sends', async () => {
	await seed(1);
	const owned = await claim();
	expect(await execution.renew(owned)).toBe(true);
	await source.query('UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval \'1 second\',attempt_count=8 WHERE work_id=$1', [owned.workId]);
	expect(await execution.expire()).toBe(1);
	expect(await pages()).toMatchObject([{ state: 'exhausted', reason_code: 'attempts_exhausted', attempt_count: 8 }]);
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'needs_attention' }]);
	expect(await children()).toEqual([]);
});

test.each(['deliver', 'postLocal'])('%s recovery blocks page execution without changing progress', async queue => {
	await seed(1);
	const input = await envelope();
	await source.query('UPDATE backend_internal.work_control SET recovery_pending=true WHERE queue_key=$1', [queue]);
	expect(await execution.claim(input, 'worker')).toBe(null);
	expect(await pages()).toMatchObject([{ state: 'ready', attempt_count: 0 }]);
});

async function existingSend(payload = '{"inbox":"https://relay.test/0001","shared":false}') {
	const id = workHash(JSON.stringify(['request', 'ap.send', 'https://relay.test/0001']));
	await source.query(`INSERT INTO backend_internal.work_item
		(work_id,request_id,kind,target_key,schema_version,payload,payload_hash,state,attempt_count,next_attempt_at,deadline_at,charged_bytes)
		SELECT $1,request_id,'ap.send','https://relay.test/0001',1,$2,$3,'succeeded',3,not_before,deadline_at,7168 FROM backend_internal.work_request`, [id, payload, workHash(payload)]);
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=reserved_rows+1,reserved_bytes=reserved_bytes+7168');
}

test('an identical existing send preserves progress and is not charged twice', async () => {
	await seed(101);
	const owned = await claim();
	await existingSend();
	const before = await capacity();
	await complete(owned);
	expect(await children()).toHaveLength(100);
	expect((await children())[0]).toMatchObject({ state: 'succeeded', attempt_count: 3 });
	const after = await capacity();
	expect(BigInt(after[0].reserved_rows) - BigInt(before[0].reserved_rows)).toBe(100n);
	expect(BigInt(after[0].reserved_bytes) - BigInt(before[0].reserved_bytes)).toBe(717824n);
});

test('all-existing identical children can settle while deletion reservations exceed the normal quota', async () => {
	await seed(1);
	const owned = await claim();
	await existingSend();
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=900001');
	const before = await capacity();
	await complete(owned);
	expect(await capacity()).toEqual(before);
	expect(await pages()).toMatchObject([{ state: 'succeeded' }]);
	expect(await children()).toMatchObject([{ state: 'succeeded', attempt_count: 3 }]);
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'settled' }]);
});

test('conflicting existing child content rolls back new siblings and quota without overwriting progress', async () => {
	await seed(101);
	const owned = await claim();
	await existingSend('{"inbox":"https://relay.test/0001","shared":true}');
	const before = await capacity();
	await expect(complete(owned)).rejects.toThrow();
	expect(await capacity()).toEqual(before);
	expect(await children()).toMatchObject([{ state: 'succeeded', attempt_count: 3, payload: '{"inbox":"https://relay.test/0001","shared":true}' }]);
	expect(await pages()).toMatchObject([{ state: 'running' }]);
});
