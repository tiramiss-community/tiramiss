/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EntityManager } from 'typeorm';
import type { PostNotification } from '../../../modules/notification/public.js';

async function lockRecipient(manager: EntityManager, recipientId: string): Promise<void> {
	if (!manager.queryRunner?.isTransactionActive || manager.queryRunner.isReleased) {
		throw new Error('Notification persistence requires an active transaction');
	}
	// PostgreSQL has no recipient notification row to lock. This only serializes retention and flush.
	await manager.query('SELECT pg_advisory_xact_lock(1792732433, hashtext($1))', [recipientId]);
}

export class PostNotificationPersistence {
	private readonly maximum: number;

	constructor(options: { perUserNotificationsMaxCount?: number } = {}) {
		this.maximum = options.perUserNotificationsMaxCount ?? 500;
		if (!Number.isSafeInteger(this.maximum) || this.maximum < 1) {
			throw new Error('Invalid per-user notification count');
		}
	}

	async save(manager: EntityManager, notification: PostNotification): Promise<void> {
		await lockRecipient(manager, notification.recipientId);
		await manager.createQueryBuilder().insert().into('backend_internal.notification').values({
			notification_id: notification.id, recipient_id: notification.recipientId, notification_type: notification.type,
			notifier_id: notification.notifierId, note_id: notification.noteId, target_note_id: notification.targetNoteId,
			created_at: new Date(notification.createdAtMs),
		}).execute();

		const old = manager.createQueryBuilder().select('body.notification_id').from('backend_internal.notification', 'body')
			.where('recipient_id=:recipientId', { recipientId: notification.recipientId })
			.orderBy('created_at', 'DESC').addOrderBy('notification_id', 'DESC').offset(this.maximum);
		await manager.createQueryBuilder().delete().from('backend_internal.notification')
			.where(`notification_id IN (${old.getQuery()})`).setParameters(old.getParameters()).execute();
	}

	async flush(manager: EntityManager, recipientId: string): Promise<void> {
		await lockRecipient(manager, recipientId);
		await manager.createQueryBuilder().delete().from('backend_internal.notification')
			.where('recipient_id=:recipientId', { recipientId }).execute();
	}
}
