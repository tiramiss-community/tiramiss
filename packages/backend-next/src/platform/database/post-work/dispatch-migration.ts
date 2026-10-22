/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PostWorkDispatch1792643873727 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		const statements = [
			`CREATE TABLE "backend_internal"."work_control" ("queue_key" character varying(32) NOT NULL, "queue_generation" bigint NOT NULL DEFAULT '1', "paused" boolean NOT NULL DEFAULT false, "reserved_dispatches" integer NOT NULL DEFAULT '0', "capacity_formula_version" integer NOT NULL DEFAULT '1', "charged_bytes" bigint NOT NULL, CONSTRAINT "work_control_formula_positive" CHECK (capacity_formula_version > 0), CONSTRAINT "work_control_charge_positive" CHECK (charged_bytes > 0 AND charged_bytes % 1024 = 0), CONSTRAINT "work_control_queue" CHECK (queue_key IN ('deliver','postLocal')), CONSTRAINT "work_control_generation" CHECK (queue_generation > 0), CONSTRAINT "work_control_bounds" CHECK (reserved_dispatches BETWEEN 0 AND 10000), CONSTRAINT "work_control_bytes_queue_key" CHECK (octet_length("queue_key") BETWEEN 1 AND 32), CONSTRAINT "PK_98bcf273fbcc85a7f5da442d553" PRIMARY KEY ("queue_key"))`,
			`CREATE TABLE "backend_internal"."queue_dispatch" ("work_id" character varying(128) NOT NULL, "dispatch_seq" bigint NOT NULL, "queue_key" character varying(32) NOT NULL, "queue_generation" bigint NOT NULL, "token" character varying(128) NOT NULL, "token_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "reserved_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_checked_at" TIMESTAMP WITH TIME ZONE NOT NULL, "state" character varying(32) NOT NULL DEFAULT 'reserved', "released_at" TIMESTAMP WITH TIME ZONE, "capacity_formula_version" integer NOT NULL DEFAULT '1', "charged_bytes" bigint NOT NULL, CONSTRAINT "queue_dispatch_formula_positive" CHECK (capacity_formula_version > 0), CONSTRAINT "queue_dispatch_charge_positive" CHECK (charged_bytes > 0 AND charged_bytes % 1024 = 0), CONSTRAINT "queue_dispatch_counters" CHECK (dispatch_seq > 0 AND queue_generation > 0), CONSTRAINT "queue_dispatch_expiry" CHECK (token_expires_at = reserved_at + interval '60 seconds'), CONSTRAINT "queue_dispatch_state" CHECK (state IN ('reserved','enqueue_unknown','enqueued','retired','released')), CONSTRAINT "queue_dispatch_released" CHECK ((state = 'released') = (released_at IS NOT NULL)), CONSTRAINT "queue_dispatch_bytes_work_id" CHECK (octet_length("work_id") BETWEEN 1 AND 128), CONSTRAINT "queue_dispatch_bytes_queue_key" CHECK (octet_length("queue_key") BETWEEN 1 AND 32), CONSTRAINT "queue_dispatch_bytes_token" CHECK (octet_length("token") BETWEEN 1 AND 128), CONSTRAINT "queue_dispatch_bytes_state" CHECK (octet_length("state") BETWEEN 1 AND 32), CONSTRAINT "PK_7f031761e23541e7c1d5175ce07" PRIMARY KEY ("work_id", "dispatch_seq"))`,
			`CREATE INDEX "dispatch_pending" ON "backend_internal"."queue_dispatch"  ("last_checked_at", "work_id", "dispatch_seq") WHERE state <> 'released'`,
			`CREATE INDEX "dispatch_retention" ON "backend_internal"."queue_dispatch"  ("released_at", "work_id", "dispatch_seq") `,
			`ALTER TABLE "backend_internal"."queue_dispatch" ADD CONSTRAINT "dispatch_item" FOREIGN KEY ("work_id") REFERENCES "backend_internal"."work_item"("work_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
			`ALTER TABLE "backend_internal"."queue_dispatch" ADD CONSTRAINT "dispatch_queue" FOREIGN KEY ("queue_key") REFERENCES "backend_internal"."work_control"("queue_key") ON DELETE NO ACTION ON UPDATE NO ACTION`,
		];
		for (const statement of statements) {
			await runner.query(statement);
		}
		await runner.query("INSERT INTO backend_internal.work_control (queue_key,charged_bytes) VALUES ('deliver',2048),('postLocal',2048)");
		await runner.query("UPDATE backend_internal.work_capacity SET reserved_rows=reserved_rows+2, reserved_bytes=reserved_bytes+4096 WHERE capacity_key='global'");
	}

	async down(runner: QueryRunner): Promise<void> {
		await runner.query(`UPDATE backend_internal.work_capacity
			SET reserved_rows=reserved_rows-(SELECT count(*) FROM backend_internal.queue_dispatch)-2,
			reserved_bytes=reserved_bytes-COALESCE((SELECT sum(charged_bytes) FROM backend_internal.queue_dispatch),0)-4096
			WHERE capacity_key='global'`);
		await runner.query('DROP TABLE backend_internal.queue_dispatch');
		await runner.query('DROP TABLE backend_internal.work_control');
	}
}
