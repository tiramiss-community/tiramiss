/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDatabase } from '../helpers/database.js';
import { createDataSource } from '../../src/platform/database/data-source.js';
import { internalMigrations, migrationSources } from '../../src/platform/database/migration-sources.js';
import { assertMigrationsApplied } from '../../src/platform/database/check-migrations.js';
import { assertSchemaMatches } from '../../src/platform/database/check-schema.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;
let internal: DataSource;
const removedTables = ['notification_effect', 'ap_host_lease', 'delivery_recipient', 'queue_dispatch', 'work_control', 'work_item', 'work_request', 'note_work_state', 'work_capacity'];
const bodies = () => source.query('SELECT notification_id,recipient_id,notification_type,notifier_id,note_id,target_note_id,created_at FROM backend_internal.notification ORDER BY notification_id');
const publicState = () => source.query("SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position");

beforeAll(async () => {
	database = await createTestDatabase();
	const sources = migrationSources(database.config.database);
	await sources.upstream.initialize();
	await sources.upstream.runMigrations();
	await sources.upstream.destroy();
	// Reproduce the schema shipped by PR #212, without running the retirement migration.
	await sources.internal.setOptions({ migrations: internalMigrations.slice(0, 6) }).initialize();
	await sources.internal.query('CREATE SCHEMA backend_internal');
	await sources.internal.runMigrations();
	await sources.internal.destroy();
	source = await createDataSource(database.config.database).initialize();
	internal = await migrationSources(database.config.database).internal.initialize();
});
beforeEach(async () => {
	await source.query(`TRUNCATE ${[...removedTables, 'notification'].map(name => `backend_internal.${name}`).join(',')}`);
	await source.query("INSERT INTO backend_internal.work_capacity(capacity_key,reserved_rows,reserved_bytes,charged_bytes) VALUES ('global',3,6144,2048)");
	await source.query("INSERT INTO backend_internal.work_control(queue_key,charged_bytes) VALUES ('deliver',2048),('postLocal',2048)");
	await source.query(`INSERT INTO backend_internal.note_work_state(note_id,actor_id,generation,create_event_id,visibility,local_only,recipient_coverage,last_dependency_at,charged_bytes)
		VALUES ('note','author',1,'event','public',false,'fixed',now(),2048)`);
	await source.query(`INSERT INTO backend_internal.work_request(request_id,event_id,note_id,actor_id,note_generation,kind,schema_version,note_facts,payload,payload_hash,occurred_at,not_before,deadline_at,state,finished_at,charged_bytes)
		VALUES ('request','event','note','author',1,'notification.create',1,'{}','{}',repeat('a',64),now()-interval '2 days',now()-interval '2 days',now()-interval '1 day','settled',now(),2048)`);
	await source.query(`INSERT INTO backend_internal.work_item(work_id,request_id,kind,target_key,schema_version,payload,payload_hash,state,next_attempt_at,deadline_at,finished_at,charged_bytes)
		VALUES ('work','request','notification.create','recipient',1,'{}',repeat('a',64),'succeeded',now()-interval '2 days',now()-interval '1 day',now(),2048)`);
	await source.query(`INSERT INTO backend_internal.queue_dispatch(work_id,dispatch_seq,queue_key,queue_generation,token,token_expires_at,reserved_at,last_checked_at,state,released_at,charged_bytes)
		VALUES ('work',1,'postLocal',1,'token',now()+interval '60 seconds',now(),now(),'released',now(),2048)`);
	await source.query(`INSERT INTO backend_internal.delivery_recipient(create_event_id,inbox,request_id,note_id,actor_id,activity_id,shared,send_state,fixed_at,retain_until,charged_bytes)
		VALUES ('event','https://remote.test/inbox','request','note','author','activity',false,'succeeded',now(),now()+interval '90 days',2048)`);
	await source.query("INSERT INTO backend_internal.ap_host_lease(host,slot,last_used_at,charged_bytes) VALUES ('remote.test',0,now(),2048)");
	await source.query(`INSERT INTO backend_internal.notification(notification_id,recipient_id,notification_type,notifier_id,note_id,target_note_id,created_at,charged_bytes)
		VALUES ('notification','recipient','renote','author','note','original','2026-11-03T00:00:00Z',3072)`);
	await source.query(`INSERT INTO backend_internal.notification_effect(request_id,recipient_id,notification_type,notification_id,formed_at,charged_bytes)
		VALUES ('request','recipient','renote','notification',now(),2048)`);
});

// Undo the retirement and every migration added after it, returning to the schema shipped by PR #212.
async function undoRetirement() {
	for (;;) {
		const [latest] = await source.query('SELECT name FROM backend_internal.migrations ORDER BY id DESC LIMIT 1');
		if (latest.name.startsWith('ApHostLease')) {
			return;
		}
		await internal.undoLastMigration();
	}
}

afterEach(async () => {
	await undoRetirement();
});
afterAll(async () => {
	await internal?.destroy();
	await source?.destroy();
	await database?.close();
});

test('retires completed protocol data while preserving every notification business field and public schema/history', async () => {
	const before = await bodies();
	const upstream = await publicState();
	const history = await source.query('SELECT * FROM public.migrations ORDER BY id');
	const oldHistory = await source.query('SELECT * FROM backend_internal.migrations ORDER BY id');
	await internal.runMigrations();
	expect(await bodies()).toEqual(before);
	expect(await publicState()).toEqual(upstream);
	expect(await source.query('SELECT * FROM public.migrations ORDER BY id')).toEqual(history);
	expect(await source.query('SELECT * FROM backend_internal.migrations ORDER BY id LIMIT 6')).toEqual(oldHistory);
	for (const name of removedTables) {
		expect(await source.query('SELECT to_regclass($1) AS table', [`backend_internal.${name}`])).toEqual([{ table: null }]);
	}
	expect(await source.query("SELECT column_name FROM information_schema.columns WHERE table_schema='backend_internal' AND table_name='notification' AND column_name IN ('charged_bytes','capacity_formula_version')")).toEqual([]);
	await assertMigrationsApplied(database.config.database);
	await assertSchemaMatches(database.config.database);
	expect(await internal.runMigrations()).toEqual([]);
});

const blockers = [
	['request', "UPDATE backend_internal.work_request SET state='open'"],
	['request', "UPDATE backend_internal.work_request SET state='needs_attention'"],
	...['ready', 'retry_wait', 'running', 'failed_permanent', 'exhausted', 'exhausted_unknown', 'quarantined'].map(state => ['item', `UPDATE backend_internal.work_item SET state='${state}'`]),
	['item', "UPDATE backend_internal.work_item SET execution_owner='worker',execution_until=now()-interval '1 day'"],
	['dispatch', "UPDATE backend_internal.queue_dispatch SET state='enqueue_unknown',released_at=NULL"],
	['control', 'UPDATE backend_internal.work_control SET reserved_dispatches=1'],
	['control', 'UPDATE backend_internal.work_control SET recovery_pending=true'],
	['host', "UPDATE backend_internal.ap_host_lease SET work_id='work',execution_owner='worker',execution_epoch=1,lease_epoch=1,lease_id='00000000-0000-0000-0000-000000000001',lease_until=now()-interval '1 day'"],
	...['pending', 'sending', 'unknown', 'failed_permanent', 'exhausted_unknown'].map(state => ['recipient', `UPDATE backend_internal.delivery_recipient SET send_state='${state}'`]),
];
test.each(blockers)('refuses unresolved %s state even after its deadline, without modifying data or migration history: %s', async (kind, mutation) => {
	await source.query(mutation!);
	const before = await bodies();
	const history = await source.query('SELECT * FROM backend_internal.migrations ORDER BY id');
	await expect(internal.runMigrations()).rejects.toMatchObject({ code: 'DURABLE_WORK_REQUIRES_REVIEW', details: { [kind!]: expect.any(Number) } });
	expect(await bodies()).toEqual(before);
	expect(await source.query('SELECT * FROM backend_internal.migrations ORDER BY id')).toEqual(history);
	for (const name of removedTables) {
		expect((await source.query('SELECT to_regclass($1) AS table', [`backend_internal.${name}`]))[0].table).not.toBe(null);
	}
});

test('down restores empty legacy tables and accounts for retained notifications; up remains repeatable', async () => {
	const before = await bodies();
	await internal.runMigrations();
	await undoRetirement();
	expect(await bodies()).toEqual(before);
	expect(await source.query('SELECT count(*)::int AS count FROM backend_internal.work_request')).toEqual([{ count: 0 }]);
	expect(await source.query('SELECT count(*)::int AS count FROM backend_internal.notification_effect')).toEqual([{ count: 0 }]);
	expect(await source.query('SELECT capacity_formula_version,charged_bytes FROM backend_internal.notification')).toEqual([{ capacity_formula_version: 1, charged_bytes: '3072' }]);
	expect(await source.query('SELECT reserved_rows,reserved_bytes FROM backend_internal.work_capacity')).toEqual([{ reserved_rows: '4', reserved_bytes: '9216' }]);
	await internal.runMigrations();
	expect(await bodies()).toEqual(before);
	await assertSchemaMatches(database.config.database);
});
