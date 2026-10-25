/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';
export class WorkPhysicalCapacity1792903206054 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		await runner.query(`ALTER TABLE backend_internal.work_capacity
		 ADD COLUMN physical_observed_at timestamptz,
		 ADD COLUMN physical_free_bytes bigint,
		 ADD COLUMN physical_total_bytes bigint,
		 ADD COLUMN physical_volume_id varchar(128),
		 ADD COLUMN capacity_coefficient integer NOT NULL DEFAULT 4,
		 ADD CONSTRAINT work_capacity_bytes_physical_volume_id CHECK (octet_length("physical_volume_id") BETWEEN 1 AND 128)`);
	}
	async down(runner: QueryRunner): Promise<void> {
		await runner.query(`ALTER TABLE backend_internal.work_capacity
		 DROP CONSTRAINT work_capacity_bytes_physical_volume_id, DROP COLUMN physical_observed_at, DROP COLUMN physical_free_bytes,
		 DROP COLUMN physical_total_bytes, DROP COLUMN physical_volume_id, DROP COLUMN capacity_coefficient`);
	}
}
