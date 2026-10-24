/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { MiNote, MiUser } from 'backend-upstream/entities';
import type { DataSource } from 'typeorm';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { migrateDatabase } from '../../src/platform/database/migrate.js';

import { withPostWorkRequests } from '../../src/platform/database/post-work/append.js';
import { PostWorkDispatchStore } from '../../src/platform/database/post-work/dispatch.js';
import { PostWorkLocalExecutionStore } from '../../src/platform/database/post-work/local-execution.js';
import { PostNotificationPersistence } from '../../src/platform/database/notification/persistence.js';
import { PostNotification1792732433541 } from '../../src/platform/database/notification/migration.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';
import type { NotificationWorkRequest } from '../../src/modules/post-work/public.js';
import type { PostNotificationDecision, PostNotificationFacts, PostNotificationType } from '../../src/modules/notification/public.js';
import type { LocalExecutionClaim, LocalExecutionEnvelope } from '../../src/platform/jobs/local-execution.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let execution: PostWorkLocalExecutionStore;
let storage: PostNotificationPersistence;
let sequence = 0;
const deliver = async (): Promise<PostNotificationDecision> => ({ status: 'deliver' });

beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
	source = await createDataSource(database.config.database).initialize();
	execution = new PostWorkLocalExecutionStore(source);
	await source.getRepository(MiUser).insert([
		{ id: 'actor', username: 'actor', usernameLower: 'actor' },
		{ id: 'recipient', username: 'recipient', usernameLower: 'recipient' },
		{ id: 'remote', username: 'remote', usernameLower: 'remote', host: 'remote.test' },
	]);
});
beforeEach(async () => {
	await source.query('TRUNCATE backend_internal.ap_host_lease, backend_internal.delivery_recipient, backend_internal.notification, backend_internal.notification_effect, backend_internal.queue_dispatch, backend_internal.work_item, backend_internal.work_request, backend_internal.note_work_state');
	await source.getRepository(MiNote).deleteAll();
	await source.query('UPDATE backend_internal.work_capacity SET reserved_rows=3, reserved_bytes=6144');
	await source.query('UPDATE backend_internal.work_control SET reserved_dispatches=0, paused=false, queue_generation=1');
	sequence = 0;
	storage = new PostNotificationPersistence({ newId: () => `notification${++sequence}`, perUserNotificationsMaxCount: 2 });
});

afterAll(async () => {
	await source?.destroy();
	await database?.close();
});

test('migrations provide durable notification bodies and independent effect records', async () => {
	expect(await source.query("SELECT to_regclass('backend_internal.notification')::text AS body, to_regclass('backend_internal.notification_effect')::text AS effect"))
		.toEqual([{ body: 'backend_internal.notification', effect: 'backend_internal.notification_effect' }]);
});

async function seed(suffix = '', type: PostNotificationType = 'mention', recipientId = 'recipient') {
	await source.getRepository(MiNote).insert({ id: `note${suffix}`, userId: 'actor', text: '実投稿', visibility: 'public' });
	if (type === 'renote') {
		await source.getRepository(MiNote).insert({ id: `target${suffix}`, userId: 'actor', text: '対象投稿', visibility: 'public' });
		await source.getRepository(MiNote).update({ id: `note${suffix}` }, { renoteId: `target${suffix}` });
	}
	const now = Date.now() - 1000;
	const request: NotificationWorkRequest = {
		requestId: `request${suffix}`, eventId: `event${suffix}`, noteId: `note${suffix}`, actorId: 'actor',
		note: { visibility: 'public', localOnly: false, channelId: null }, noteGeneration: 1,
		kind: 'notification.create', schemaVersion: 1, occurredAtMs: now, notBeforeMs: now,
		payload: { candidates: [{ recipientId, type }] },
	};
	await source.transaction(manager => withPostWorkRequests(manager, tx => tx.append(request)));
	const dispatched = await new PostWorkDispatchStore(source).claim('scanner');
	if (dispatched.status !== 'claimed') {
		throw new Error('Missing dispatch');
	}
	const { workId, kind, schemaVersion, dispatchSeq, queueGeneration } = dispatched.reservation;
	const envelope: LocalExecutionEnvelope = { workId, kind, schemaVersion, dispatchSeq, queueGeneration };
	const owned = await execution.claim(envelope, 'worker');
	if (!owned) {
		throw new Error('Missing execution');
	}
	return { owned, envelope, request };
}

const complete = (owned: LocalExecutionClaim, recheck: (facts: PostNotificationFacts) => Promise<PostNotificationDecision> = deliver) => source.transaction(manager => storage.complete(manager, owned, recheck));
const bodies = () => source.query('SELECT * FROM backend_internal.notification ORDER BY notification_id');
const effects = () => source.query('SELECT * FROM backend_internal.notification_effect ORDER BY request_id');
const capacity = () => source.query('SELECT reserved_rows, reserved_bytes FROM backend_internal.work_capacity');
const item = async () => (await source.query('SELECT * FROM backend_internal.work_item'))[0];

test.each(['reply', 'mention', 'quote', 'renote', 'note'] as const)('saves a complete %s body, effect and successful item together', async type => {
	const { owned, envelope } = await seed('', type);
	let received: PostNotificationFacts | undefined;
	const effect = await complete(owned, async facts => {
		received = facts;
		return { status: 'deliver' };
	});
	expect(received).toMatchObject({ recipientId: 'recipient', type, note: { id: 'note', authorId: 'actor' } });
	expect(effect).toEqual({ requestId: 'request', recipientId: 'recipient', type, notificationId: 'notification1', reason: null });
	expect(await bodies()).toMatchObject([{
		notification_id: 'notification1', recipient_id: 'recipient', notification_type: type,
		notifier_id: 'actor', note_id: 'note', target_note_id: type === 'renote' ? 'target' : null,
	}]);
	expect((await bodies())[0].created_at).toBeInstanceOf(Date);
	expect(await effects()).toMatchObject([{ request_id: 'request', notification_id: 'notification1', reason_code: null }]);
	expect(await item()).toMatchObject({ state: 'succeeded', result_ref: 'notification1', execution_owner: null });
	expect(await source.query('SELECT state FROM backend_internal.work_request')).toEqual([{ state: 'settled' }]);
	expect(await execution.claim(envelope, 'duplicate')).toBe(null);
});

test('calls the mandatory reception check with real current facts and records suppression', async () => {
	const { owned } = await seed();
	const before = await capacity();
	const result = await complete(owned, async facts => {
		expect(facts.note.id).toBe('note');
		return { status: 'suppress', reason: 'muted' };
	});
	expect(result).toMatchObject({ notificationId: null, reason: 'muted' });
	expect(await bodies()).toEqual([]);
	expect(await item()).toMatchObject({ state: 'skipped', reason_code: 'muted' });
	const after = await capacity();
	expect(BigInt(after[0].reserved_rows) - BigInt(before[0].reserved_rows)).toBe(1n);
});

test.each(['self', 'missing_recipient', 'remote_recipient', 'missing_note', 'invalid_renote'])('records %s without a deficient notification body', async condition => {
	const recipient = condition === 'self' ? 'actor' : condition === 'missing_recipient' ? 'missing' : condition === 'remote_recipient' ? 'remote' : 'recipient';
	const { owned } = await seed('', condition === 'invalid_renote' ? 'renote' : 'mention', recipient);
	if (condition === 'missing_note') {
		await source.getRepository(MiNote).delete({ id: 'note' });
	}
	if (condition === 'invalid_renote') {
		await source.getRepository(MiNote).update({ id: 'note' }, { renoteId: null });
	}
	await complete(owned);
	expect(await bodies()).toEqual([]);
	expect((await effects())[0].reason_code).toBe(condition);
	expect((await item()).state).toBe('skipped');
});

test('a transaction failure after notification persistence rolls back body, effect, progress and quota', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await expect(source.transaction(async manager => {
		await storage.complete(manager, owned, deliver);
		throw new Error('before commit');
	})).rejects.toThrow('before commit');
	expect(await bodies()).toEqual([]);
	expect(await effects()).toEqual([]);
	expect(await item()).toMatchObject({ state: 'running', attempt_count: 1 });
	expect(await capacity()).toEqual(before);
});

test('lease expiry during reception checking rolls back every result write', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await expect(source.transaction(manager => storage.complete(manager, owned, async () => {
		await manager.query("UPDATE backend_internal.work_item SET execution_until=clock_timestamp()-interval '1 second'");
		return { status: 'deliver' };
	}))).rejects.toThrow('execution');
	expect(await bodies()).toEqual([]);
	expect(await effects()).toEqual([]);
	expect(await capacity()).toEqual(before);
});

test.each(['owner', 'epoch', 'cancelled', 'deadline'])('rejects %s before invoking the reception check', async damage => {
	const { owned } = await seed();
	if (damage === 'owner') {
		await source.query("UPDATE backend_internal.work_item SET execution_owner='new_worker'");
	} else if (damage === 'epoch') {
		await source.query('UPDATE backend_internal.work_item SET execution_epoch=execution_epoch+1');
	} else if (damage === 'cancelled') {
		await source.query("UPDATE backend_internal.note_work_state SET generation=2,deleted_at=clock_timestamp(),cancel_event_id='delete'");
	} else {
		await source.query("UPDATE backend_internal.work_item SET deadline_at=clock_timestamp()-interval '1 second'");
	}
	let checked = false;
	await expect(complete(owned, async () => {
		checked = true;
		return { status: 'deliver' };
	})).rejects.toThrow('execution');
	expect(checked).toBe(false);
	expect(await bodies()).toEqual([]);
	expect(await effects()).toEqual([]);
});

test('parallel completion of the same item creates exactly one body and effect', async () => {
	const { owned } = await seed();
	const results = await Promise.allSettled([complete(owned), complete(owned)]);
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
	expect(await bodies()).toHaveLength(1);
	expect(await effects()).toHaveLength(1);
});

test('different events to the same recipient remain separate notifications', async () => {
	const first = await seed('1');
	const second = await seed('2');
	await Promise.all([complete(first.owned), complete(second.owned)]);
	expect(await bodies()).toHaveLength(2);
	expect(await effects()).toHaveLength(2);
});

test('concurrent additions trim the oldest bodies while preserving every effect and exact quota', async () => {
	const claims = [];
	for (let i = 0; i < 5; i++) {
		claims.push((await seed(String(i))).owned);
	}
	const before = await capacity();
	await Promise.all(claims.map(owned => complete(owned)));
	expect(await bodies()).toMatchObject([{ notification_id: 'notification4' }, { notification_id: 'notification5' }]);
	expect(await effects()).toHaveLength(5);
	const rows = [...await bodies(), ...await effects()];
	const after = await capacity();
	expect(BigInt(after[0].reserved_rows) - BigInt(before[0].reserved_rows)).toBe(7n);
	expect(BigInt(after[0].reserved_bytes) - BigInt(before[0].reserved_bytes)).toBe(rows.reduce((sum, row) => sum + BigInt(row.charged_bytes), 0n));
});

test('flush releases only body quota, retains effects and cannot recreate a deleted notification', async () => {
	const { owned, envelope } = await seed();
	await complete(owned);
	const before = await capacity();
	const [body] = await bodies();
	await source.transaction(manager => storage.flush(manager, 'recipient'));
	await source.transaction(manager => storage.flush(manager, 'recipient'));
	expect(await bodies()).toEqual([]);
	expect(await effects()).toHaveLength(1);
	const after = await capacity();
	expect(BigInt(before[0].reserved_rows) - BigInt(after[0].reserved_rows)).toBe(1n);
	expect(BigInt(before[0].reserved_bytes) - BigInt(after[0].reserved_bytes)).toBe(BigInt(body.charged_bytes));
	expect(await execution.claim(envelope, 'late')).toBe(null);
	expect(await storage.readEffect(source.manager, 'request', 'recipient', 'mention')).toMatchObject({ notificationId: 'notification1' });
	// Progress repair must also respect the independently retained result.
	await source.query("UPDATE backend_internal.work_item SET state='running', execution_owner='worker', execution_until=clock_timestamp()+interval '60 seconds'");
	await complete(owned, async () => {
		throw new Error('must reuse effect');
	});
	expect(await bodies()).toEqual([]);
	expect(await effects()).toHaveLength(1);
});

test.each(['rows', 'bytes'])('%s capacity exhaustion rolls back all notification writes', async bound => {
	const { owned } = await seed();
	await source.query(bound === 'rows' ? 'UPDATE backend_internal.work_capacity SET reserved_rows=900000' : 'UPDATE backend_internal.work_capacity SET reserved_bytes=19327352832');
	const before = await capacity();
	await expect(complete(owned)).rejects.toThrow('capacity');
	expect(await bodies()).toEqual([]);
	expect(await effects()).toEqual([]);
	expect(await item()).toMatchObject({ state: 'running' });
	expect(await capacity()).toEqual(before);
});

test('claim payload mutation cannot redirect the stored notification target', async () => {
	const { owned } = await seed();
	owned.payload.recipientId = 'remote';
	await complete(owned);
	expect(await bodies()).toMatchObject([{ recipient_id: 'recipient' }]);
});

test('saved payload corruption after claim fails without notification effects', async () => {
	const { owned } = await seed();
	await source.query("UPDATE backend_internal.work_item SET payload='{}'");
	await expect(complete(owned)).rejects.toThrow();
	expect(await bodies()).toEqual([]);
	expect(await effects()).toEqual([]);
});

test('commit acknowledgement loss is resolved by reading durable results after reconnect', async () => {
	const { owned, envelope } = await seed();
	const runner = source.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	await storage.complete(runner.manager, owned, deliver);
	const commit = runner.commitTransaction.bind(runner);
	runner.commitTransaction = async () => {
		await commit();
		throw new Error('commit acknowledgement lost');
	};
	await expect(runner.commitTransaction()).rejects.toThrow('acknowledgement');
	await runner.release();
	await source.destroy();
	source = await createDataSource(database.config.database).initialize();
	execution = new PostWorkLocalExecutionStore(source);
	expect(await storage.readEffect(source.manager, 'request', 'recipient', 'mention')).toMatchObject({ notificationId: 'notification1' });
	expect(await execution.claim(envelope, 'restarted')).toBe(null);
	expect(await bodies()).toHaveLength(1);
});

test('notification migration down frees retained charges and up restores matching schema', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await complete(owned);
	const runner = source.createQueryRunner();
	await runner.connect();
	try {
		await runner.startTransaction();
		await new PostNotification1792732433541().down(runner);
		await runner.commitTransaction();
		expect(await capacity()).toEqual(before);
		await runner.startTransaction();
		await new PostNotification1792732433541().up(runner);
		await runner.commitTransaction();
		await assertSchemaMatches(database.config.database);
	} finally {
		await runner.release();
	}
});

test('persistence requires a live caller-owned transaction', async () => {
	const { owned } = await seed();
	await expect(storage.complete(source.manager, owned, deliver)).rejects.toThrow('transaction');
	await expect(storage.flush(source.manager, 'recipient')).rejects.toThrow('transaction');
});

test('an effect insert failure rolls back the preceding real notification insert', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await source.query(`CREATE FUNCTION reject_notification_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'effect insert failed'; END $$`);
	await source.query('CREATE TRIGGER reject_effect BEFORE INSERT ON backend_internal.notification_effect FOR EACH ROW EXECUTE FUNCTION reject_notification_effect()');
	try {
		await expect(complete(owned)).rejects.toThrow('effect insert failed');
		expect(await bodies()).toEqual([]);
		expect(await effects()).toEqual([]);
		expect(await capacity()).toEqual(before);
		expect((await item()).state).toBe('running');
	} finally {
		await source.query('DROP TRIGGER reject_effect ON backend_internal.notification_effect');
		await source.query('DROP FUNCTION reject_notification_effect()');
	}
});

test.each([0, -1, 0.5, NaN, 1000001])('rejects unsafe per-user notification count %s', count => {
	expect(() => new PostNotificationPersistence({ newId: () => 'id', perUserNotificationsMaxCount: count })).toThrow('count');
});

test('charges the body and retained effect independently using the persisted formula', async () => {
	const { owned } = await seed();
	const before = await capacity();
	await complete(owned);
	expect((await bodies())[0]).toMatchObject({ capacity_formula_version: 1, charged_bytes: '3072' });
	expect((await effects())[0]).toMatchObject({ capacity_formula_version: 1, charged_bytes: '2048' });
	const after = await capacity();
	expect(BigInt(after[0].reserved_rows) - BigInt(before[0].reserved_rows)).toBe(2n);
	expect(BigInt(after[0].reserved_bytes) - BigInt(before[0].reserved_bytes)).toBe(5120n);
});

test('no observer can see a notification body or effect before the result transaction commits', async () => {
	const { owned } = await seed();
	const runner = source.createQueryRunner();
	await runner.connect();
	await runner.startTransaction();
	try {
		await storage.complete(runner.manager, owned, deliver);
		expect(await bodies()).toEqual([]);
		expect(await effects()).toEqual([]);
		expect((await item()).state).toBe('running');
		await runner.commitTransaction();
		expect(await bodies()).toHaveLength(1);
		expect(await effects()).toHaveLength(1);
		expect((await item()).state).toBe('succeeded');
	} finally {
		if (runner.isTransactionActive) {
			await runner.rollbackTransaction();
		}
		await runner.release();
	}
});

test('mutating the caller claim during reception checking cannot complete another item', async () => {
	const first = await seed('1');
	const second = await seed('2');
	const firstId = first.owned.workId;
	await complete(first.owned, async () => {
		Object.assign(first.owned, second.owned);
		return { status: 'deliver' };
	});
	expect(await source.query('SELECT state FROM backend_internal.work_item WHERE work_id=$1', [firstId])).toEqual([{ state: 'succeeded' }]);
	expect(await source.query('SELECT state FROM backend_internal.work_item WHERE work_id=$1', [second.owned.workId])).toEqual([{ state: 'running' }]);
	expect(await bodies()).toMatchObject([{ note_id: 'note1' }]);
	expect(await effects()).toMatchObject([{ request_id: 'request1' }]);
});
