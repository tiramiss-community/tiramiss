/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { DiagnosticError } from '../diagnostic-error.js';
import { PostWorkPersistence1792590060271 } from './post-work/migrations.js';
import { PostWorkDispatch1792643873727 } from './post-work/dispatch-migration.js';
import { PostWorkRecovery1792665615537 } from './post-work/recovery-migration.js';
import { ApRecipientSnapshot1792734340852 } from './ap/migration.js';
import { ApHostLease1792815498061 } from './ap/host-migration.js';

const tables = ['notification_effect', 'ap_host_lease', 'delivery_recipient', 'queue_dispatch', 'work_control', 'work_item', 'work_request', 'note_work_state', 'work_capacity'];

export class RetireDurableWork1793635233676 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		// Run only while stopped. Lock before inspection so no writer can race the retirement.
		await runner.query(`LOCK TABLE ${[...tables, 'notification'].map(name => `backend_internal.${name}`).join(',')} IN ACCESS EXCLUSIVE MODE`);
		const [counts] = await runner.query(`SELECT
			(SELECT count(*) FROM backend_internal.work_request WHERE state <> 'settled') AS request,
			(SELECT count(*) FROM backend_internal.work_item WHERE state NOT IN ('succeeded','skipped','cancelled')
				OR dispatch_owner IS NOT NULL OR execution_owner IS NOT NULL) AS item,
			(SELECT count(*) FROM backend_internal.queue_dispatch WHERE state <> 'released') AS dispatch,
			(SELECT count(*) FROM backend_internal.work_control WHERE reserved_dispatches <> 0 OR recovery_pending) AS control,
			(SELECT count(*) FROM backend_internal.ap_host_lease WHERE lease_id IS NOT NULL OR lease_until IS NOT NULL
				OR execution_owner IS NOT NULL OR execution_epoch IS NOT NULL) AS host,
			(SELECT count(*) FROM backend_internal.delivery_recipient WHERE send_state NOT IN ('succeeded','skipped','cancelled')) AS recipient
		`) as Record<string, string>[];
		const unresolved = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));
		if (Object.values(unresolved).some(count => count > 0)) {
			throw new DiagnosticError('DURABLE_WORK_REQUIRES_REVIEW', unresolved);
		}

		for (const table of tables) {
			await runner.query(`DROP TABLE backend_internal.${table}`);
		}
		await runner.query('ALTER TABLE backend_internal.notification DROP COLUMN capacity_formula_version, DROP COLUMN charged_bytes');
	}

	async down(runner: QueryRunner): Promise<void> {
		// This restores schema, not retired job/effect history. A full rollback requires the stopped backup.
		await new PostWorkPersistence1792590060271().up(runner);
		await new PostWorkDispatch1792643873727().up(runner);
		await new PostWorkRecovery1792665615537().up(runner);
		await new ApRecipientSnapshot1792734340852().up(runner);
		await new ApHostLease1792815498061().up(runner);
		await runner.query(`ALTER TABLE backend_internal.notification
			ADD COLUMN capacity_formula_version integer NOT NULL DEFAULT 1,
			ADD COLUMN charged_bytes bigint`);
		await runner.query(`UPDATE backend_internal.notification SET charged_bytes =
			1024 * ceil(4::numeric * (512 + octet_length(notification_id || recipient_id || notification_type || notifier_id || note_id || COALESCE(target_note_id,''))) / 1024)`);
		await runner.query(`ALTER TABLE backend_internal.notification
			ALTER COLUMN charged_bytes SET NOT NULL,
			ADD CONSTRAINT notification_formula_positive CHECK (capacity_formula_version > 0),
			ADD CONSTRAINT notification_charge_positive CHECK (charged_bytes > 0 AND charged_bytes % 1024 = 0)`);
		await runner.query("CREATE TABLE \"backend_internal\".\"notification_effect\" (\"request_id\" character varying(128) NOT NULL, \"recipient_id\" character varying(128) NOT NULL, \"notification_type\" character varying(16) NOT NULL, \"notification_id\" character varying(128), \"reason_code\" character varying(64), \"formed_at\" TIMESTAMP WITH TIME ZONE NOT NULL, \"capacity_formula_version\" integer NOT NULL DEFAULT '1', \"charged_bytes\" bigint NOT NULL, CONSTRAINT \"notification_effect_formula_positive\" CHECK (capacity_formula_version > 0), CONSTRAINT \"notification_effect_charge_positive\" CHECK (charged_bytes > 0 AND charged_bytes % 1024 = 0), CONSTRAINT \"notification_effect_type\" CHECK (notification_type IN ('reply','mention','quote','renote','note')), CONSTRAINT \"notification_effect_outcome\" CHECK ((notification_id IS NULL) <> (reason_code IS NULL)), CONSTRAINT \"notification_effect_reason\" CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]*$'), CONSTRAINT \"notification_effect_bytes_request_id\" CHECK (octet_length(\"request_id\") BETWEEN 1 AND 128), CONSTRAINT \"notification_effect_bytes_recipient_id\" CHECK (octet_length(\"recipient_id\") BETWEEN 1 AND 128), CONSTRAINT \"notification_effect_bytes_notification_type\" CHECK (octet_length(\"notification_type\") BETWEEN 1 AND 16), CONSTRAINT \"notification_effect_bytes_notification_id\" CHECK (octet_length(\"notification_id\") BETWEEN 1 AND 128), CONSTRAINT \"notification_effect_bytes_reason_code\" CHECK (octet_length(\"reason_code\") BETWEEN 1 AND 64), CONSTRAINT \"PK_493c96595c2ec597b896a3eb43c\" PRIMARY KEY (\"request_id\", \"recipient_id\", \"notification_type\"))");
		await runner.query("CREATE INDEX \"notification_effect_retention\" ON \"backend_internal\".\"notification_effect\"  (\"formed_at\", \"request_id\") ");
		await runner.query("ALTER TABLE \"backend_internal\".\"notification_effect\" ADD CONSTRAINT \"notification_effect_request\" FOREIGN KEY (\"request_id\") REFERENCES \"backend_internal\".\"work_request\"(\"request_id\") ON DELETE NO ACTION ON UPDATE NO ACTION");
		await runner.query(`UPDATE backend_internal.work_capacity SET
			reserved_rows = reserved_rows + (SELECT count(*) FROM backend_internal.notification),
			reserved_bytes = reserved_bytes + COALESCE((SELECT sum(charged_bytes) FROM backend_internal.notification),0)
			WHERE capacity_key='global'`);
	}
}
