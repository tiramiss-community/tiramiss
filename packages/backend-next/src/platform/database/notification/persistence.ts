/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiNote, MiUser } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { NotificationEffect, PostNotificationDecision, PostNotificationFacts, PostNotificationType } from '../../../modules/notification/public.js';
import { assertPhysicalCapacity, physicalCapacityCondition } from '../work-capacity/gate.js';
import { WorkCapacityExceeded } from '../../../modules/post-work/public.js';
import { chargedBytes, workCapacity } from '../../../modules/post-work/prepare.js';
import { withLocalWorkCompletion } from '../post-work/local-execution.js';
import { LocalWorkValidationCache } from '../post-work/local-work-validation.js';
import type { SavedLocalRequest } from '../post-work/local-work-validation.js';
import type { LocalExecutionClaim } from '../../jobs/local-execution.js';

interface EffectRow {
	request_id: string; recipient_id: string; notification_type: PostNotificationType;
	notification_id: string | null; reason_code: string | null;
}
interface ChargeRow { charged_bytes: string }

type Recheck = (facts: PostNotificationFacts) => Promise<PostNotificationDecision>;

function requireTransaction(manager: EntityManager): void {
	if (!manager.queryRunner?.isTransactionActive || manager.queryRunner.isReleased) {
		throw new Error('Notification persistence requires an active transaction');
	}
}

function effect(row: EffectRow): NotificationEffect {
	return {
		requestId: row.request_id, recipientId: row.recipient_id, type: row.notification_type,
		notificationId: row.notification_id, reason: row.reason_code,
	};
}

async function lockRecipient(manager: EntityManager, recipientId: string): Promise<void> {
	// There is no upstream notification row to lock. Hash collisions only serialize unrelated recipients.
	await manager.query('SELECT pg_advisory_xact_lock(1792732433, hashtext($1))', [recipientId]);
}

async function adjustCapacity(manager: EntityManager, rows: number, bytes: number, growing: boolean): Promise<void> {
	const query = manager.createQueryBuilder().update('backend_internal.work_capacity')
		.set({ reserved_rows: () => 'reserved_rows + :rows', reserved_bytes: () => 'reserved_bytes + :bytes' })
		.where('capacity_key=:key AND capacity_formula_version=:version')
		.setParameters({ key: 'global', version: workCapacity.formulaVersion, rows, bytes });
	if (growing) {
		query.andWhere(physicalCapacityCondition);
		query.andWhere('reserved_rows + :rows <= :rowLimit AND reserved_bytes + :bytes <= :byteLimit')
			.setParameters({ rowLimit: workCapacity.rows * 0.9, byteLimit: Math.floor(workCapacity.bytes * 0.9) });
	}
	if ((await query.execute()).affected !== 1) {
		throw new WorkCapacityExceeded('The durable notification capacity is full or requires reconciliation');
	}
	if (growing) {
		await assertPhysicalCapacity(manager);
	}
}

export class PostNotificationPersistence {
	private readonly validation = new LocalWorkValidationCache();
	private readonly maximum: number;

	constructor(private readonly options: { newId: (atMs: number) => string; perUserNotificationsMaxCount?: number }) {
		this.maximum = options.perUserNotificationsMaxCount ?? 500;
		if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > workCapacity.rows) {
			throw new Error('Invalid per-user notification count');
		}
	}

	async readEffect(manager: EntityManager, requestId: string, recipientId: string, type: PostNotificationType): Promise<NotificationEffect | null> {
		const row = await manager.createQueryBuilder().select('effect.*').from('backend_internal.notification_effect', 'effect')
			.where('request_id=:requestId AND recipient_id=:recipientId AND notification_type=:type', { requestId, recipientId, type })
			.getRawOne<EffectRow>();
		return row ? effect(row) : null;
	}

	/** The caller must await this operation and propagate failures out of its transaction. */
	async complete(manager: EntityManager, claim: LocalExecutionClaim, recheck: Recheck): Promise<NotificationEffect> {
		requireTransaction(manager);
		const fixedClaim = { ...claim };
		if (fixedClaim.kind !== 'notification.create' || typeof recheck !== 'function') {
			throw new Error('Notification work and an explicit reception check are required');
		}
		let saved: NotificationEffect | undefined;
		await withLocalWorkCompletion(manager, fixedClaim, async () => {
			const request = await manager.createQueryBuilder().select('request.*').from('backend_internal.work_request', 'request')
				.where('request_id=:requestId', fixedClaim).getRawOne<SavedLocalRequest>();
			const item = await manager.createQueryBuilder().select('item.*').from('backend_internal.work_item', 'item')
				.where('work_id=:workId', fixedClaim).getRawOne<{
					kind: string; schema_version: number; target_key: string; payload: string | null; payload_hash: string; deadline_at: Date;
				}>();
			const validated = request && item ? this.validation.validate(item, request) : null;
			if (!validated || validated.request.kind !== 'notification.create') {
				throw new Error('Invalid saved notification work');
			}
			const { recipientId, type } = validated.payload as { recipientId: string; type: PostNotificationType };
			saved = await this.readEffect(manager, fixedClaim.requestId, recipientId, type) ?? undefined;
			if (!saved) {
				saved = await this.form(manager, validated.request.noteId, validated.request.actorId, fixedClaim.requestId, recipientId, type, recheck);
			}
			return saved.notificationId !== null
				? { status: 'succeeded', resultRef: saved.notificationId }
				: { status: 'skipped', reason: saved.reason! };
		});
		return saved!;
	}

	/** Removes bodies only; retained effects must survive user flushes and retention trimming. */
	async flush(manager: EntityManager, recipientId: string): Promise<void> {
		requireTransaction(manager);
		await lockRecipient(manager, recipientId);
		const removed = await manager.createQueryBuilder().delete().from('backend_internal.notification')
			.where('recipient_id=:recipientId', { recipientId }).returning('charged_bytes').execute();
		const charges = removed.raw as ChargeRow[];
		if (charges.length) {
			await adjustCapacity(manager, -charges.length, -charges.reduce((sum, row) => sum + Number(row.charged_bytes), 0), false);
		}
	}

	private async form(
		manager: EntityManager, noteId: string, actorId: string, requestId: string,
		recipientId: string, type: PostNotificationType, recheck: Recheck,
	): Promise<NotificationEffect> {
		await lockRecipient(manager, recipientId);
		const note = await manager.getRepository(MiNote).findOneBy({ id: noteId });
		const recipient = await manager.getRepository(MiUser).findOneBy({ id: recipientId });
		let reason: string | null = null;
		if (!note) {
			reason = 'missing_note';
		} else if (note.userId !== actorId || note.userHost !== null) {
			throw new Error('The saved notification does not refer to the local posting actor');
		} else if (!recipient) {
			reason = 'missing_recipient';
		} else if (recipient.host !== null) {
			reason = 'remote_recipient';
		} else if (recipientId === actorId) {
			reason = 'self';
		} else if (type === 'renote' && note.renoteId === null) {
			reason = 'invalid_renote';
		} else {
			const decision = await recheck(Object.freeze({
				recipientId, type, note: Object.freeze({ id: note.id, authorId: note.userId, renoteId: note.renoteId }),
			}));
			if (decision.status === 'suppress' && /^[a-z][a-z0-9_]{0,63}$/.test(decision.reason)) {
				reason = decision.reason;
			} else if (decision.status !== 'deliver') {
				throw new Error('Invalid notification reception decision');
			}
		}

		const [{ now }] = await manager.query('SELECT clock_timestamp() AS now') as { now: Date }[];
		let notificationId: string | null = null;
		let bodyBytes = 0;
		let removed: ChargeRow[] = [];
		if (reason === null) {
			notificationId = this.options.newId(now.getTime());
			if (typeof notificationId !== 'string' || Buffer.byteLength(notificationId) < 1 || Buffer.byteLength(notificationId) > 128
				|| notificationId.includes('\u0000') || Buffer.from(notificationId).toString('utf8') !== notificationId) {
				throw new Error('Invalid notification ID');
			}
			const targetNoteId = type === 'renote' ? note!.renoteId : null;
			bodyBytes = chargedBytes(512, notificationId + recipientId + type + actorId + noteId + (targetNoteId ?? ''));
			await manager.createQueryBuilder().insert().into('backend_internal.notification').values({
				notification_id: notificationId, recipient_id: recipientId, notification_type: type,
				notifier_id: actorId, note_id: noteId, target_note_id: targetNoteId, created_at: now, charged_bytes: bodyBytes,
			}).execute();
			const old = manager.createQueryBuilder().select('body.notification_id').from('backend_internal.notification', 'body')
				.where('recipient_id=:recipientId', { recipientId }).orderBy('created_at', 'DESC').addOrderBy('notification_id', 'DESC')
				.offset(this.maximum);
			const deleted = await manager.createQueryBuilder().delete().from('backend_internal.notification')
				.where(`notification_id IN (${old.getQuery()})`).setParameters(old.getParameters()).returning('charged_bytes').execute();
			removed = deleted.raw as ChargeRow[];
		}

		const effectBytes = chargedBytes(256, requestId + recipientId + type + (notificationId ?? '') + (reason ?? ''));
		await manager.createQueryBuilder().insert().into('backend_internal.notification_effect').values({
			request_id: requestId, recipient_id: recipientId, notification_type: type,
			notification_id: notificationId, reason_code: reason, formed_at: now, charged_bytes: effectBytes,
		}).execute();
		await adjustCapacity(manager, 1 + (notificationId === null ? 0 : 1) - removed.length,
			effectBytes + bodyBytes - removed.reduce((sum, row) => sum + Number(row.charged_bytes), 0), true);
		return { requestId, recipientId, type, notificationId, reason };
	}
}
