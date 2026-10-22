/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { DispatchTransport, WorkQueue } from '../../jobs/dispatch.js';
import { PostWorkDispatchStore } from './dispatch.js';

interface RecoveryTransport extends Pick<DispatchTransport, 'retire'> {
	readGeneration(queue: WorkQueue): Promise<string | null>;
	replaceGeneration(queue: WorkQueue, expected: string | null, generation: string): Promise<void>;
}
interface Control {
	queue_key: WorkQueue;
	queue_generation: string;
	recovery_pending: boolean;
}
type Generations = Record<WorkQueue, string>;
const queues = ['deliver', 'postLocal'] as const;

async function lockedControls(manager: EntityManager): Promise<Control[]> {
	const values = await manager.createQueryBuilder().select('control.*').from('backend_internal.work_control', 'control')
		.orderBy('queue_key').setLock('pessimistic_write').getRawMany<Control>();
	if (values.length !== 2 || values.some((value, i) => value.queue_key !== queues[i])
		|| values[0].recovery_pending !== values[1].recovery_pending) {
		throw new Error('Invalid queue recovery controls');
	}
	return values;
}

function validateGate(gate: string | null, generation: string): void {
	if (gate !== null && (!/^[1-9][0-9]{0,18}$/.test(gate) || BigInt(gate) > BigInt(generation))) {
		throw new Error('Unexpected Redis queue generation');
	}
}

/** Must finish before starting consumers, scanners or application readiness. */
export async function recoverPostWork(source: DataSource, transport: RecoveryTransport): Promise<Generations> {
	if (source.options.type !== 'postgres') {
		throw new Error('Post work recovery requires PostgreSQL');
	}
	// A pooled session must never retain the advisory lock after an unlock/connection failure.
	// Destroy this dedicated pool on every exit, including ambiguous commits and Redis failures.
	const session = new DataSource({ ...source.options, poolSize: 1, extra: { ...source.options.extra, max: 1 } });
	await session.initialize();
	const runner = session.createQueryRunner();
	try {
		await runner.connect();
		// DB-specific session lock spans the committed recovery fence and Redis operations.
		await runner.query('SELECT pg_advisory_lock(1792665615, 537)');
		const observed = {} as Record<WorkQueue, string | null>;
		for (const queue of queues) {
			observed[queue] = await transport.readGeneration(queue);
		}
		const prepared = await runner.manager.transaction(async manager => {
			const controls = await lockedControls(manager);
			for (const control of controls) {
				validateGate(observed[control.queue_key], control.queue_generation);
			}
			const pending = controls[0].recovery_pending;
			const healthy = !pending && controls.every(control => observed[control.queue_key] === control.queue_generation);
			if (!pending && !healthy) {
				await manager.createQueryBuilder().update('backend_internal.work_control').set({
					queue_generation: () => 'queue_generation + 1', recovery_pending: true,
				}).execute();
			}
			const generations = Object.fromEntries(controls.map(control => [control.queue_key,
				!pending && !healthy ? (BigInt(control.queue_generation) + 1n).toString() : control.queue_generation,
			])) as Generations;
			return { generations, healthy };
		});
		const { generations } = prepared;
		if (prepared.healthy) {
			return generations;
		}
		for (const queue of queues) {
			// Use the lock-owning connection again: a lost session must not silently reacquire a pooled connection.
			await runner.query('SELECT 1');
			await transport.replaceGeneration(queue, observed[queue], generations[queue]);
		}
		const store = new PostWorkDispatchStore(source);
		// At most20000 slots exist. Each bounded batch is released per reservation, not as one large transaction.
		for (let batch = 0; batch <= 200; batch++) {
			const older = await runner.manager.createQueryBuilder().select('dispatch.*')
				.addSelect('item.kind', 'kind').addSelect('item.schema_version', 'schema_version')
				.from('backend_internal.queue_dispatch', 'dispatch').innerJoin('work_item', 'item', 'item.work_id = dispatch.work_id')
				.where("dispatch.state <> 'released'")
				.andWhere('((dispatch.queue_key = :deliver AND dispatch.queue_generation < :deliverGeneration) OR (dispatch.queue_key = :local AND dispatch.queue_generation < :localGeneration))', {
					deliver: 'deliver', deliverGeneration: generations.deliver, local: 'postLocal', localGeneration: generations.postLocal,
				}).orderBy('dispatch.work_id').addOrderBy('dispatch.dispatch_seq').limit(100)
				.getRawMany<{
					work_id: string; kind: string; schema_version: number; dispatch_seq: string; queue_key: WorkQueue;
					queue_generation: string; token: string; reserved_at: Date; token_expires_at: Date;
				}>();
			if (older.length === 0) {
				break;
			}
			if (batch === 200) {
				throw new Error('Queue recovery exceeds reservation limit');
			}
			for (const row of older) {
				await runner.query('SELECT 1');
				const value = {
					workId: row.work_id, kind: row.kind, schemaVersion: row.schema_version, dispatchSeq: row.dispatch_seq,
					queueKey: row.queue_key, queueGeneration: row.queue_generation, token: row.token,
					reservedAtMs: row.reserved_at.getTime(), tokenExpiresAtMs: row.token_expires_at.getTime(),
				};
				if (!await transport.retire(value)) {
					throw new Error('Queue recovery blocked by active entry');
				}
				await runner.query('SELECT 1');
				await store.release(value);
			}
		}
		for (const queue of queues) {
			if (await transport.readGeneration(queue) !== generations[queue]) {
				throw new Error('Redis generation changed during recovery');
			}
		}
		await runner.manager.transaction(async manager => {
			const controls = await lockedControls(manager);
			if (controls.some(control => !control.recovery_pending || control.queue_generation !== generations[control.queue_key])) {
				throw new Error('Lost queue recovery generation');
			}
			const remaining = await manager.createQueryBuilder().select('control.queue_key').from('backend_internal.work_control', 'control')
				.where('reserved_dispatches <> 0').getRawOne();
			if (remaining) {
				throw new Error('Queue recovery has unreconciled reservations');
			}
			await manager.createQueryBuilder().update('backend_internal.work_control').set({ recovery_pending: false }).execute();
		});
		return generations;
	} finally {
		try {
			await runner.release();
		} finally {
			await session.destroy();
		}
	}
}
