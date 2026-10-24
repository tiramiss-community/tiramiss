/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { chargedBytes, workCapacity } from '../../../modules/post-work/prepare.js';
import { WorkCapacityExceeded } from '../../../modules/post-work/public.js';
import type { DataSource, EntityManager } from 'typeorm';

export interface ApHostExecution {
	workId: string;
	owner: string;
	epoch: string;
}

export interface ApHostLease extends ApHostExecution {
	host: string;
	slot: number;
	hostEpoch: string;
	token: string;
}

interface Slot {
	host: string; slot: number; work_id: string | null; execution_owner: string | null;
	execution_epoch: string | null; lease_epoch: string; lease_id: string | null; lease_until: Date | null;
}

function transaction(manager: EntityManager) {
	if (!manager.queryRunner?.isTransactionActive || manager.queryRunner.isReleased) {
		throw new Error('AP host leases require an active transaction');
	}
}

function hostOf(inbox: string): string {
	const url = new URL(inbox);
	const host = url.hostname.toLowerCase().replace(/\.+$/, '');
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host || Buffer.byteLength(host) > 253) {
		throw new Error('Invalid AP inbox host');
	}
	return host;
}

async function executionHost(manager: EntityManager, execution: ApHostExecution): Promise<string> {
	const identity = await manager.createQueryBuilder().select('request.note_id', 'note_id')
		.from('backend_internal.work_item', 'item').innerJoin('work_request', 'request', 'request.request_id=item.request_id')
		.where('item.work_id=:workId', execution).getRawOne<{ note_id: string }>();
	if (!identity) {
		throw new Error('Lost AP host execution');
	}
	await manager.createQueryBuilder().select('note.note_id').from('backend_internal.note_work_state', 'note')
		.where('note_id=:noteId', { noteId: identity.note_id }).setLock('pessimistic_write').getRawOne();
	await manager.createQueryBuilder().select('item.work_id').from('backend_internal.work_item', 'item')
		.where('work_id=:workId', execution).setLock('pessimistic_write').getRawOne();
	return currentExecutionHost(manager, execution);
}

async function currentExecutionHost(manager: EntityManager, execution: ApHostExecution): Promise<string> {
	// The preceding locks may wait past either lease; check DB time in a new statement.
	const item = await manager.createQueryBuilder().select('item.target_key', 'inbox')
		.from('backend_internal.work_item', 'item').innerJoin('work_request', 'request', 'request.request_id=item.request_id')
		.innerJoin('note_work_state', 'note', 'note.note_id=request.note_id')
		.where('item.work_id=:workId AND item.execution_owner=:owner AND item.execution_epoch=:epoch', execution)
		.andWhere('item.kind=\'ap.send\' AND item.state=\'running\' AND request.kind=\'ap.expand\'')
		.andWhere('item.execution_until > clock_timestamp() AND item.deadline_at > clock_timestamp()')
		.andWhere('(request.note_generation > 1 OR (note.generation=1 AND note.deleted_at IS NULL))')
		.getRawOne<{ inbox: string }>();
	if (!item) {
		throw new Error('Lost AP host execution');
	}
	try {
		return hostOf(item.inbox);
	} catch {
		throw new Error('Invalid AP inbox host');
	}
}

async function lockCapacity(manager: EntityManager) {
	const row = await manager.createQueryBuilder().select('capacity.capacity_key').from('backend_internal.work_capacity', 'capacity')
		.where('capacity_key=\'global\'').setLock('pessimistic_write').getRawOne();
	if (!row) {
		throw new Error('Missing work capacity');
	}
}

const leaseUntil = `(SELECT LEAST(execution_until,deadline_at,clock_timestamp()+interval '60 seconds')
	FROM backend_internal.work_item WHERE work_id=:workId)`;

function ownership(manager: EntityManager, lease: ApHostLease) {
	return manager.createQueryBuilder().update('backend_internal.ap_host_lease')
		.where('host=:host AND slot=:slot AND lease_epoch=:hostEpoch AND lease_id=:token', lease)
		.andWhere('work_id=:workId AND execution_owner=:owner AND execution_epoch=:epoch', lease);
}

export class PostApHostLeases {
	/** Host shortage throws so the caller's preceding execution claim also rolls back. */
	async acquire(manager: EntityManager, input: ApHostExecution): Promise<ApHostLease> {
		transaction(manager);
		const execution = { ...input };
		const host = await executionHost(manager, execution);
		await lockCapacity(manager);
		// Work ID is not known when an empty slot is created; reserve its maximum byte width.
		const charge = chargedBytes(256, host + 'x'.repeat(128));
		const inserted = await manager.createQueryBuilder().insert().into('backend_internal.ap_host_lease')
			.values([0, 1].map(slot => ({ host, slot, last_used_at: () => 'clock_timestamp()', charged_bytes: charge })))
			.orIgnore().returning(['host']).updateEntity(false).execute();
		const count = inserted.raw.length as number;
		if (count) {
			const quota = await manager.createQueryBuilder().update('backend_internal.work_capacity').set({
				reserved_rows: () => 'reserved_rows+:rows', reserved_bytes: () => 'reserved_bytes+:bytes',
			}).where('capacity_key=\'global\' AND capacity_formula_version=1')
				.andWhere('reserved_rows+:rows <= :maxRows AND reserved_bytes+:bytes <= :maxBytes')
				.setParameters({ rows: count, bytes: charge * count, maxRows: workCapacity.rows * 0.9, maxBytes: workCapacity.bytes * 0.9 }).execute();
			if (quota.affected !== 1) {
				throw new WorkCapacityExceeded('AP host capacity unavailable');
			}
		}
		await manager.createQueryBuilder().select('host.*').from('backend_internal.ap_host_lease', 'host')
			.where('host=:host', { host }).orderBy('slot').setLock('pessimistic_write').getRawMany();
		const rows = await manager.createQueryBuilder().select('host.*').addSelect('lease_until > clock_timestamp()', 'active')
			.from('backend_internal.ap_host_lease', 'host').where('host=:host', { host }).orderBy('slot')
			.getRawMany<Slot & { active: boolean | null }>();
		if (await currentExecutionHost(manager, execution) !== host) {
			throw new Error('Lost AP host execution');
		}
		const own = rows.find(row => row.work_id === execution.workId);
		if (own?.active && own.execution_owner === execution.owner && own.execution_epoch === execution.epoch && own.lease_id) {
			return { ...execution, host, slot: own.slot, hostEpoch: own.lease_epoch, token: own.lease_id };
		}
		const slot = own?.active ? undefined : own ?? rows.find(row => !row.active);
		if (!slot) {
			throw new Error('AP host slots unavailable');
		}
		const token = randomUUID();
		const result = await manager.createQueryBuilder().update('backend_internal.ap_host_lease').set({
			work_id: execution.workId, execution_owner: execution.owner, execution_epoch: execution.epoch,
			lease_epoch: () => 'lease_epoch+1', lease_id: token, lease_until: () => leaseUntil, last_used_at: () => 'clock_timestamp()',
		}).where('host=:host AND slot=:slot', { host, slot: slot.slot }).setParameters(execution)
			.andWhere('(lease_until IS NULL OR lease_until <= clock_timestamp())')
			.andWhere('EXISTS (SELECT 1 FROM backend_internal.work_item WHERE work_id=:workId AND execution_until > clock_timestamp() AND deadline_at > clock_timestamp())')
			.returning(['lease_epoch']).execute();
		if (result.affected !== 1) {
			throw new Error('Lost AP host execution');
		}
		return { ...execution, host, slot: slot.slot, hostEpoch: result.raw[0].lease_epoch, token };
	}

	async renew(manager: EntityManager, input: ApHostLease): Promise<void> {
		transaction(manager);
		const lease = { ...input };
		if (await executionHost(manager, lease) !== lease.host) {
			throw new Error('Lost AP host lease');
		}
		await manager.createQueryBuilder().select('host.slot').from('backend_internal.ap_host_lease', 'host')
			.where('host=:host AND slot=:slot', lease).setLock('pessimistic_write').getRawOne();
		const result = await ownership(manager, lease).set({ lease_until: () => leaseUntil, last_used_at: () => 'clock_timestamp()' })
			.andWhere('lease_until > clock_timestamp()')
			.andWhere('EXISTS (SELECT 1 FROM backend_internal.work_item WHERE work_id=:workId AND execution_until > clock_timestamp() AND deadline_at > clock_timestamp())')
			.execute();
		if (result.affected !== 1) {
			throw new Error('Lost AP host lease');
		}
	}

	async release(manager: EntityManager, input: ApHostLease): Promise<boolean> {
		transaction(manager);
		const lease = { ...input };
		const result = await ownership(manager, lease).set({
			lease_id: null, lease_until: null, execution_owner: null, execution_epoch: null,
			last_used_at: () => 'clock_timestamp()',
		}).execute();
		return result.affected === 1;
	}

	async cleanup(source: DataSource, limit = 100): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error('Invalid host cleanup batch');
		}
		return source.transaction(async manager => {
			await lockCapacity(manager);
			// Inspect every retained slot for this host, including the last referenced work's terminal time.
			const eligible = `NOT EXISTS (SELECT 1 FROM backend_internal.ap_host_lease sibling
				LEFT JOIN backend_internal.work_item item ON item.work_id=sibling.work_id
				WHERE sibling.host=host.host AND (sibling.last_used_at > clock_timestamp()-interval '30 days'
				OR sibling.lease_until > clock_timestamp() OR (item.work_id IS NOT NULL AND
				(item.state IN ('ready','retry_wait','running') OR item.finished_at IS NULL OR item.finished_at > clock_timestamp()-interval '30 days'))))`;
			const candidates = await manager.createQueryBuilder().select('host.host', 'host').addSelect('host.slot', 'slot')
				.from('backend_internal.ap_host_lease', 'host').where('last_used_at <= clock_timestamp()-interval \'30 days\'')
				.andWhere(eligible).orderBy('host.host').addOrderBy('host.slot').limit(limit)
				.setLock('pessimistic_write').setOnLocked('skip_locked').getRawMany<{ host: string; slot: number }>();
			let count = 0;
			let bytes = 0n;
			for (const row of candidates) {
				const current = await manager.createQueryBuilder().select('host.charged_bytes', 'charged_bytes')
					.from('backend_internal.ap_host_lease', 'host').where('host.host=:host AND host.slot=:slot', row)
					.andWhere(eligible).getRawOne<{ charged_bytes: string }>();
				if (!current) {
					continue;
				}
				await manager.createQueryBuilder().delete().from('backend_internal.ap_host_lease').where('host=:host AND slot=:slot', row).execute();
				count++;
				bytes += BigInt(current.charged_bytes);
			}
			if (count) {
				await manager.createQueryBuilder().update('backend_internal.work_capacity').set({
					reserved_rows: () => 'reserved_rows-:rows', reserved_bytes: () => 'reserved_bytes-:bytes',
				}).where('capacity_key=\'global\'').setParameters({ rows: count, bytes: bytes.toString() }).execute();
			}
			return count;
		});
	}
}
