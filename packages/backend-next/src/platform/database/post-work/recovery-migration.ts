/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PostWorkRecovery1792665615537 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		await runner.query('ALTER TABLE backend_internal.work_control ADD COLUMN recovery_pending boolean NOT NULL DEFAULT false');
	}

	async down(runner: QueryRunner): Promise<void> {
		await runner.query('ALTER TABLE backend_internal.work_control DROP COLUMN recovery_pending');
	}
}
