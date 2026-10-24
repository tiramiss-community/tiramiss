/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EntityManager } from 'typeorm';

export const localKinds = ['ap.expand', 'ap.expand.page', 'notification.create'];
export const activeLocalStates = ['ready', 'retry_wait', 'running'];
const attentionStates = ['failed_permanent', 'exhausted', 'exhausted_unknown', 'quarantined'];

export async function settleLocalItem(manager: EntityManager, workId: string, state: string, reason: string | null): Promise<void> {
	await manager.createQueryBuilder().update('backend_internal.work_item').set({
		state, reason_code: reason, finished_at: () => 'clock_timestamp()',
		execution_owner: null, execution_until: null,
	}).where('work_id = :workId', { workId }).execute();
}

// The caller holds the note/item locks. Locking the parent also serializes aggregate writes.
export async function aggregateLocalRequest(manager: EntityManager, requestId: string): Promise<void> {
	await manager.createQueryBuilder().select('request.request_id').from('backend_internal.work_request', 'request')
		.where('request_id = :requestId', { requestId }).setLock('pessimistic_write').getRawOne();
	const remaining = await manager.createQueryBuilder().select('item.work_id').from('backend_internal.work_item', 'item')
		.where('request_id = :requestId', { requestId }).andWhere('state IN (:...states)', { states: activeLocalStates }).limit(1).getRawOne();
	if (remaining) {
		return;
	}
	const attention = await manager.createQueryBuilder().select('item.work_id').from('backend_internal.work_item', 'item')
		.where('request_id = :requestId', { requestId }).andWhere('state IN (:...states)', { states: attentionStates }).limit(1).getRawOne();
	await manager.createQueryBuilder().update('backend_internal.work_request').set({
		state: attention ? 'needs_attention' : 'settled', finished_at: () => 'clock_timestamp()',
	}).where('request_id = :requestId', { requestId }).execute();
}
