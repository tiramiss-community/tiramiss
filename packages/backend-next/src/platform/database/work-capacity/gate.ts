/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { WorkCapacityExceeded } from '../../../modules/post-work/public.js';
import type { EntityManager } from 'typeorm';

// clock_timestamp is deliberate: a transaction may wait for locks past the sample expiry.
export const physicalCapacityCondition = `physical_observed_at <= clock_timestamp()
 AND physical_observed_at > clock_timestamp() - interval '120 seconds'
 AND physical_free_bytes >= 2147483648 AND physical_free_bytes::numeric * 10 >= physical_total_bytes`;

export async function assertPhysicalCapacity(manager: EntityManager): Promise<void> {
	if (!manager.queryRunner?.isTransactionActive || manager.queryRunner.isReleased) {
		throw new Error('Physical admission requires an active transaction');
	}
	// Hold the observation stable until commit; check time in a second statement after lock waits.
	await manager.createQueryBuilder().select('capacity.capacity_key').from('backend_internal.work_capacity', 'capacity')
		.where("capacity_key='global'").setLock('pessimistic_read').getRawOne();
	const row = await manager.createQueryBuilder().select('capacity.capacity_key')
		.from('backend_internal.work_capacity', 'capacity').where("capacity_key='global'")
		.andWhere(physicalCapacityCondition).getRawOne();
	if (!row) {
		throw new WorkCapacityExceeded('PostgreSQL volume capacity is low or unknown');
	}
}
