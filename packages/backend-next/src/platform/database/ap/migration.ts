/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ApRecipientSnapshot1792734340852 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		await runner.query('CREATE TABLE "backend_internal"."delivery_recipient" ("create_event_id" character varying(128) NOT NULL, "inbox" character varying(2048) NOT NULL, "request_id" character varying(128) NOT NULL, "note_id" character varying(128) NOT NULL, "actor_id" character varying(128) NOT NULL, "activity_id" character varying(2048) NOT NULL, "shared" boolean NOT NULL, "send_state" character varying(32) NOT NULL DEFAULT \'pending\', "fixed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "retain_until" TIMESTAMP WITH TIME ZONE NOT NULL, "capacity_formula_version" integer NOT NULL DEFAULT \'1\', "charged_bytes" bigint NOT NULL, CONSTRAINT "delivery_recipient_formula_positive" CHECK (capacity_formula_version > 0), CONSTRAINT "delivery_recipient_charge_positive" CHECK (charged_bytes > 0 AND charged_bytes % 1024 = 0), CONSTRAINT "delivery_recipient_send_state" CHECK (send_state IN (\'pending\',\'sending\',\'succeeded\',\'skipped\',\'cancelled\',\'failed_permanent\',\'unknown\',\'exhausted\',\'exhausted_unknown\')), CONSTRAINT "delivery_recipient_retention_bounds" CHECK (retain_until >= fixed_at), CONSTRAINT "delivery_recipient_bytes_create_event_id" CHECK (octet_length("create_event_id") BETWEEN 1 AND 128), CONSTRAINT "delivery_recipient_bytes_inbox" CHECK (octet_length("inbox") BETWEEN 1 AND 2048), CONSTRAINT "delivery_recipient_bytes_request_id" CHECK (octet_length("request_id") BETWEEN 1 AND 128), CONSTRAINT "delivery_recipient_bytes_note_id" CHECK (octet_length("note_id") BETWEEN 1 AND 128), CONSTRAINT "delivery_recipient_bytes_actor_id" CHECK (octet_length("actor_id") BETWEEN 1 AND 128), CONSTRAINT "delivery_recipient_bytes_activity_id" CHECK (octet_length("activity_id") BETWEEN 1 AND 2048), CONSTRAINT "delivery_recipient_bytes_send_state" CHECK (octet_length("send_state") BETWEEN 1 AND 32), CONSTRAINT "PK_961b65e3c48841606d39ee50958" PRIMARY KEY ("create_event_id", "inbox"))');
		await runner.query('CREATE INDEX "delivery_recipient_page" ON "backend_internal"."delivery_recipient"  ("request_id", "inbox") ');
		await runner.query('CREATE INDEX "delivery_recipient_retention" ON "backend_internal"."delivery_recipient"  ("retain_until", "create_event_id") ');
		await runner.query('ALTER TABLE "backend_internal"."delivery_recipient" ADD CONSTRAINT "delivery_recipient_request" FOREIGN KEY ("request_id") REFERENCES "backend_internal"."work_request"("request_id") ON DELETE NO ACTION ON UPDATE NO ACTION');
	}

	async down(runner: QueryRunner): Promise<void> {
		await runner.query(`UPDATE backend_internal.work_capacity SET
			reserved_rows=reserved_rows-(SELECT count(*) FROM backend_internal.delivery_recipient),
			reserved_bytes=reserved_bytes-COALESCE((SELECT sum(charged_bytes) FROM backend_internal.delivery_recipient),0)
			WHERE capacity_key='global'`);
		await runner.query('DROP TABLE backend_internal.delivery_recipient');
	}
}
