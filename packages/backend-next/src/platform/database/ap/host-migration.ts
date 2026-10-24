/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ApHostLease1792815498061 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		await runner.query('CREATE TABLE "backend_internal"."ap_host_lease" ("host" character varying(253) NOT NULL, "slot" integer NOT NULL, "work_id" character varying(128), "execution_owner" character varying(128), "execution_epoch" bigint, "lease_epoch" bigint NOT NULL DEFAULT \'0\', "lease_id" uuid, "lease_until" TIMESTAMP WITH TIME ZONE, "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL, "capacity_formula_version" integer NOT NULL DEFAULT \'1\', "charged_bytes" bigint NOT NULL, CONSTRAINT "ap_host_lease_work" UNIQUE ("work_id"), CONSTRAINT "ap_host_lease_formula_positive" CHECK (capacity_formula_version > 0), CONSTRAINT "ap_host_lease_charge_positive" CHECK (charged_bytes > 0 AND charged_bytes % 1024 = 0), CONSTRAINT "ap_host_lease_slot" CHECK (slot IN (0,1)), CONSTRAINT "ap_host_lease_epochs" CHECK (lease_epoch >= 0 AND (execution_epoch IS NULL OR execution_epoch > 0)), CONSTRAINT "ap_host_lease_ownership" CHECK ((lease_id IS NULL AND lease_until IS NULL AND execution_owner IS NULL AND execution_epoch IS NULL) OR (lease_id IS NOT NULL AND lease_until IS NOT NULL AND execution_owner IS NOT NULL AND execution_epoch IS NOT NULL AND work_id IS NOT NULL AND lease_epoch > 0)), CONSTRAINT "ap_host_lease_bytes_host" CHECK (octet_length("host") BETWEEN 1 AND 253), CONSTRAINT "ap_host_lease_bytes_work_id" CHECK (octet_length("work_id") BETWEEN 1 AND 128), CONSTRAINT "ap_host_lease_bytes_execution_owner" CHECK (octet_length("execution_owner") BETWEEN 1 AND 128), CONSTRAINT "PK_e16874aff381577c563e0e9b3ed" PRIMARY KEY ("host", "slot"))');
		await runner.query('CREATE INDEX "ap_host_lease_retention" ON "backend_internal"."ap_host_lease"  ("last_used_at", "host", "slot") ');
		await runner.query('ALTER TABLE "backend_internal"."ap_host_lease" ADD CONSTRAINT "ap_host_lease_item" FOREIGN KEY ("work_id") REFERENCES "backend_internal"."work_item"("work_id") ON DELETE NO ACTION ON UPDATE NO ACTION');
	}

	async down(runner: QueryRunner): Promise<void> {
		await runner.query(`UPDATE backend_internal.work_capacity SET
			reserved_rows=reserved_rows-(SELECT count(*) FROM backend_internal.ap_host_lease),
			reserved_bytes=reserved_bytes-COALESCE((SELECT sum(charged_bytes) FROM backend_internal.ap_host_lease),0)
			WHERE capacity_key='global'`);
		await runner.query('DROP TABLE backend_internal.ap_host_lease');
	}
}
