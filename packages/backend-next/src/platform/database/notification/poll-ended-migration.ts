/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PollEndedNotification1793706223869 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		await runner.query(`ALTER TABLE backend_internal.notification
			ALTER COLUMN notifier_id DROP NOT NULL,
			DROP CONSTRAINT notification_type,
			ADD CONSTRAINT notification_type CHECK (notification_type IN ('reply','mention','quote','renote','note','pollEnded')),
			ADD CONSTRAINT notification_notifier CHECK ((notification_type = 'pollEnded') = (notifier_id IS NULL))`);
	}

	async down(runner: QueryRunner): Promise<void> {
		// 以前の定義は通知元のない行を表せない。戻すときは pollEnded の通知を変換せずに削除する。
		await runner.query("DELETE FROM backend_internal.notification WHERE notification_type = 'pollEnded'");
		await runner.query(`ALTER TABLE backend_internal.notification
			DROP CONSTRAINT notification_notifier,
			DROP CONSTRAINT notification_type,
			ADD CONSTRAINT notification_type CHECK (notification_type IN ('reply','mention','quote','renote','note')),
			ALTER COLUMN notifier_id SET NOT NULL`);
	}
}
