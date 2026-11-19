/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AchievementNotification1795060044090 implements MigrationInterface {
	async up(runner: QueryRunner): Promise<void> {
		await runner.query(`ALTER TABLE backend_internal.notification
			ALTER COLUMN notification_type TYPE varchar(32),
			ALTER COLUMN note_id DROP NOT NULL,
			ADD COLUMN achievement varchar(128),
			DROP CONSTRAINT notification_type,
			DROP CONSTRAINT notification_notifier,
			DROP CONSTRAINT notification_bytes_notification_type,
			ADD CONSTRAINT notification_type CHECK (notification_type IN ('reply','mention','quote','renote','note','pollEnded','achievementEarned')),
			ADD CONSTRAINT notification_notifier CHECK ((notification_type IN ('pollEnded','achievementEarned')) = (notifier_id IS NULL)),
			ADD CONSTRAINT notification_achievement CHECK ((notification_type = 'achievementEarned') = (achievement IS NOT NULL) AND (notification_type = 'achievementEarned') = (note_id IS NULL)),
			ADD CONSTRAINT notification_bytes_notification_type CHECK (octet_length(notification_type) BETWEEN 1 AND 32),
			ADD CONSTRAINT notification_bytes_achievement CHECK (octet_length(achievement) BETWEEN 1 AND 128)`);
	}

	async down(runner: QueryRunner): Promise<void> {
		// The earlier schema cannot represent achievements. Retain every existing note notification.
		await runner.query("DELETE FROM backend_internal.notification WHERE notification_type = 'achievementEarned'");
		await runner.query(`ALTER TABLE backend_internal.notification
			DROP CONSTRAINT notification_achievement,
			DROP CONSTRAINT notification_bytes_achievement,
			DROP CONSTRAINT notification_type,
			DROP CONSTRAINT notification_notifier,
			DROP CONSTRAINT notification_bytes_notification_type,
			DROP COLUMN achievement,
			ALTER COLUMN notification_type TYPE varchar(16),
			ALTER COLUMN note_id SET NOT NULL,
			ADD CONSTRAINT notification_type CHECK (notification_type IN ('reply','mention','quote','renote','note','pollEnded')),
			ADD CONSTRAINT notification_notifier CHECK ((notification_type = 'pollEnded') = (notifier_id IS NULL)),
			ADD CONSTRAINT notification_bytes_notification_type CHECK (octet_length(notification_type) BETWEEN 1 AND 16)`);
	}
}
