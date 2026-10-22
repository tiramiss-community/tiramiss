/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { chargedBytes, workCapacity } from '../../../modules/post-work/prepare.js';
import type { DispatchReservation, DispatchTransport, WorkQueue } from '../../jobs/dispatch.js';

type ClaimResult = { status: 'empty' | 'waiting' } | { status: 'claimed'; reservation: DispatchReservation };

interface DispatchRow {
	work_id: string; kind: string; schema_version: number; dispatch_seq: string; queue_key: WorkQueue;
	queue_generation: string; token: string; reserved_at: Date; token_expires_at: Date;
}

function reservation(row: DispatchRow): DispatchReservation {
	return {
		workId: row.work_id, kind: row.kind, schemaVersion: row.schema_version, dispatchSeq: row.dispatch_seq,
		queueKey: row.queue_key, queueGeneration: row.queue_generation, token: row.token,
		reservedAtMs: row.reserved_at.getTime(), tokenExpiresAtMs: row.token_expires_at.getTime(),
	};
}

async function nowMs(manager: EntityManager): Promise<number> {
	const row = await manager.createQueryBuilder().select('clock_timestamp()', 'now')
		.from('backend_internal.work_capacity', 'capacity').where("capacity.capacity_key = 'global'").getRawOne<{ now: Date }>();
	if (!row) {
		throw new Error('Missing post work capacity');
	}
	return row.now.getTime();
}

export class PostWorkDispatchStore {
	constructor(private readonly source: DataSource) {}

	async databaseNowMs(): Promise<number> {
		return nowMs(this.source.manager);
	}

	async claim(owner: string): Promise<ClaimResult> {
		if (!owner || Buffer.byteLength(owner) > 128) {
			throw new Error('Invalid dispatch owner');
		}
		return this.source.transaction(async manager => {
			const item = await manager.createQueryBuilder().select('item.*').addSelect('request.note_generation', 'note_generation')
				.from('backend_internal.work_item', 'item')
				.innerJoin('work_request', 'request', 'request.request_id = item.request_id')
				.where("item.state IN ('ready','retry_wait','running')")
				.andWhere('item.next_attempt_at <= clock_timestamp() AND item.deadline_at > clock_timestamp()')
				.andWhere('(item.execution_until IS NULL OR item.execution_until <= clock_timestamp())')
				.andWhere('(item.dispatch_until IS NULL OR item.dispatch_until <= clock_timestamp())')
				.andWhere("(item.last_enqueued_at IS NULL OR item.last_enqueued_at <= clock_timestamp() - interval '60 seconds')")
				.andWhere(query => `NOT EXISTS ${query.subQuery().select('1')
					.from('backend_internal.queue_dispatch', 'live')
					.where('live.work_id = item.work_id')
					.andWhere("live.state IN ('reserved','enqueue_unknown')")
					.andWhere('live.token_expires_at > clock_timestamp()').getQuery()}`)
				.orderBy('item.next_attempt_at').addOrderBy('item.work_id').limit(1)
				.setLock('pessimistic_write', undefined, ['item']).setOnLocked('skip_locked')
				.getRawOne<{ work_id: string; kind: string; schema_version: number; dispatch_seq: string; note_generation: number }>();
			if (!item) {
				return { status: 'empty' };
			}
			const queueKey: WorkQueue = item.kind === 'ap.send' ? 'deliver' : 'postLocal';
			const queues = item.kind === 'ap.expand' || item.kind === 'ap.expand.page' ? ['deliver', 'postLocal'] : [queueKey];
			const controls = await manager.createQueryBuilder().select('control.*').from('backend_internal.work_control', 'control')
				.where('control.queue_key IN (:...queues)', { queues }).orderBy('control.queue_key').setLock('pessimistic_write')
				.getRawMany<{ queue_key: WorkQueue; queue_generation: string; paused: boolean; recovery_pending: boolean; reserved_dispatches: number }>();
			const control = controls.find(control => control.queue_key === queueKey);
			if (!control || controls.length !== queues.length) {
				throw new Error('Missing work queue control');
			}
			if (controls.some(value => value.recovery_pending)) {
				return { status: 'waiting' };
			}
			const wait = async (reason: string): Promise<ClaimResult> => {
				await manager.createQueryBuilder().update('backend_internal.work_item').set({
					state: 'retry_wait', reason_code: reason,
					next_attempt_at: () => "LEAST(clock_timestamp() + interval '30 seconds', deadline_at)",
				}).where('work_id = :workId', { workId: item.work_id }).execute();
				return { status: 'waiting' };
			};
			const paused = controls.some(control => control.paused);
			if (paused || control.reserved_dispatches >= 10000) {
				return wait(paused ? 'paused' : 'capacity_wait');
			}
			const now = await nowMs(manager);
			const dispatchSeq = (BigInt(item.dispatch_seq) + 1n).toString();
			const token = randomUUID();
			const bytes = chargedBytes(512, item.work_id + queueKey + token);
			const fraction = item.note_generation >= 2 ? 1 : 0.9;
			const reserved = await manager.createQueryBuilder().update('backend_internal.work_capacity')
				.set({ reserved_rows: () => 'reserved_rows + 1', reserved_bytes: () => 'reserved_bytes + :bytes' })
				.where("capacity_key = 'global'")
				.andWhere('reserved_rows + 1 <= :rows AND reserved_bytes + :bytes <= :maxBytes', {
					rows: workCapacity.rows * fraction, bytes, maxBytes: workCapacity.bytes * fraction,
				}).execute();
			if (reserved.affected !== 1) {
				return wait('capacity_wait');
			}
			await manager.createQueryBuilder().update('backend_internal.work_control')
				.set({ reserved_dispatches: () => 'reserved_dispatches + 1' }).where('queue_key = :queueKey', { queueKey }).execute();
			await manager.createQueryBuilder().insert().into('backend_internal.queue_dispatch').values({
				work_id: item.work_id, dispatch_seq: dispatchSeq, queue_key: queueKey, queue_generation: control.queue_generation,
				token, reserved_at: new Date(now), last_checked_at: new Date(now), token_expires_at: new Date(now + 60000), charged_bytes: bytes,
			}).execute();
			const updated = await manager.createQueryBuilder().update('backend_internal.work_item').set({
				dispatch_owner: owner, dispatch_until: new Date(now + 30000), dispatch_epoch: () => 'dispatch_epoch + 1', dispatch_seq: dispatchSeq,
			}).where('work_id = :workId', { workId: item.work_id })
				.andWhere('(dispatch_until IS NULL OR dispatch_until <= clock_timestamp())')
				.andWhere('deadline_at > clock_timestamp()').execute();
			if (updated.affected !== 1) {
				throw new Error('Lost dispatch claim');
			}
			return { status: 'claimed', reservation: {
				workId: item.work_id, kind: item.kind, schemaVersion: item.schema_version, dispatchSeq, queueKey,
				queueGeneration: control.queue_generation, token, reservedAtMs: now, tokenExpiresAtMs: now + 60000,
			} };
		});
	}

	async enqueued(value: DispatchReservation, owner: string): Promise<boolean> {
		return this.source.transaction(async manager => {
			// seq increases on every claim, so it fences reused owners as well as epoch.
			const updated = await manager.createQueryBuilder().update('backend_internal.work_item').set({
				last_enqueued_at: () => 'clock_timestamp()', dispatch_owner: null, dispatch_until: null,
			}).where('work_id = :workId AND dispatch_seq = :seq AND dispatch_owner = :owner AND dispatch_until > clock_timestamp()', {
				workId: value.workId, seq: value.dispatchSeq, owner,
			}).execute();
			if (updated.affected !== 1) {
				return false;
			}
			await manager.createQueryBuilder().update('backend_internal.queue_dispatch').set({ state: 'enqueued' })
				.where("work_id = :workId AND dispatch_seq = :seq AND state IN ('reserved','enqueue_unknown')", { workId: value.workId, seq: value.dispatchSeq }).execute();
			return true;
		});
	}

	async pending(limit = 100, expiredOnly = false): Promise<DispatchReservation[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error('Invalid dispatch batch size');
		}
		const query = this.source.createQueryBuilder().select('dispatch.*').addSelect('item.kind', 'kind').addSelect('item.schema_version', 'schema_version')
			.from('backend_internal.queue_dispatch', 'dispatch').innerJoin('work_item', 'item', 'item.work_id = dispatch.work_id')
			.where("dispatch.state <> 'released'");
		if (expiredOnly) {
			query.andWhere('dispatch.token_expires_at <= clock_timestamp()');
		}
		return (await query.orderBy('dispatch.last_checked_at').addOrderBy('dispatch.work_id').addOrderBy('dispatch.dispatch_seq').limit(limit)
			.getRawMany<DispatchRow>()).map(reservation);
	}

	async checked(value: DispatchReservation): Promise<void> {
		await this.source.createQueryBuilder().update('backend_internal.queue_dispatch')
			.set({ last_checked_at: () => 'clock_timestamp()' })
			.where("work_id = :workId AND dispatch_seq = :seq AND state <> 'released'", { workId: value.workId, seq: value.dispatchSeq }).execute();
	}

	// Call only after transport.retire confirmed no entry can consume this slot.
	async release(value: DispatchReservation): Promise<boolean> {
		return this.source.transaction(async manager => {
			const updated = await manager.createQueryBuilder().update('backend_internal.queue_dispatch')
				.set({ state: 'released', released_at: () => 'clock_timestamp()' })
				.where("work_id = :workId AND dispatch_seq = :seq AND token = :token AND state <> 'released'", {
					workId: value.workId, seq: value.dispatchSeq, token: value.token,
				}).execute();
			if (updated.affected !== 1) {
				return false;
			}
			await manager.createQueryBuilder().update('backend_internal.work_control').set({ reserved_dispatches: () => 'reserved_dispatches - 1' })
				.where('queue_key = :queueKey', { queueKey: value.queueKey }).execute();
			return true;
		});
	}
}

export async function scanPostWork(store: PostWorkDispatchStore, transport: DispatchTransport, owner: string): Promise<void> {
	for (let candidate = 0; candidate < 100; candidate++) {
		const result = await store.claim(owner);
		if (result.status === 'empty') {
			break;
		}
		if (result.status === 'claimed') {
			await transport.enqueue(result.reservation, await store.databaseNowMs());
			await store.enqueued(result.reservation, owner);
		}
	}
}

export async function reconcilePostWork(store: PostWorkDispatchStore, transport: DispatchTransport): Promise<void> {
	for (const value of await store.pending(100, true)) {
		await store.checked(value);
		if (await transport.retire(value)) {
			await store.release(value);
		}
	}
}
