/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { LostLocalExecution } from '../../jobs/local-execution.js';
import { LocalWorkValidationCache } from './local-work-validation.js';
import { activeLocalStates, aggregateLocalRequest, localKinds, settleLocalItem } from './local-execution-state.js';
import type { SavedLocalRequest } from './local-work-validation.js';
import type { LocalExecutionClaim, LocalExecutionEnvelope, LocalWorkOutcome } from '../../jobs/local-execution.js';
import type { DataSource, EntityManager } from 'typeorm';

interface ItemRow {
	work_id: string; request_id: string; kind: string; schema_version: number; target_key: string;
	payload: string | null; payload_hash: string; state: string; attempt_count: number;
	execution_owner: string | null; execution_epoch: string; execution_until: Date | null; deadline_at: Date;
	active: boolean; expired: boolean; future: boolean;
}
interface RequestRow extends SavedLocalRequest { future: boolean }
interface NoteRow { note_id: string; generation: number; deleted_at: Date | null }

function validText(value: unknown, max: number): value is string {
	return typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= max
		&& !value.includes('\u0000') && Buffer.from(value).toString('utf8') === value;
}

function counter(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function envelope(value: unknown): value is LocalExecutionEnvelope {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const data = value as Record<string, unknown>;
	return Object.keys(data).length === 5 && validText(data.workId, 128) && validText(data.kind, 64)
		&& Number.isSafeInteger(data.schemaVersion) && (data.schemaVersion as number) > 0
		&& counter(data.dispatchSeq) && counter(data.queueGeneration);
}

async function lockLocalItem(manager: EntityManager, workId: string) {
	const identity = await manager.createQueryBuilder().select('request.note_id', 'note_id')
		.from('backend_internal.work_item', 'item').innerJoin('work_request', 'request', 'request.request_id = item.request_id')
		.where('item.work_id = :workId', { workId }).getRawOne<{ note_id: string }>();
	if (!identity) {
		return null;
	}
	const note = await manager.createQueryBuilder().select('note.*').from('backend_internal.note_work_state', 'note')
		.where('note_id = :noteId', { noteId: identity.note_id }).setLock('pessimistic_write').getRawOne<NoteRow>();
	const item = await manager.createQueryBuilder().select('item.*')
		.addSelect('execution_until > clock_timestamp()', 'active')
		.addSelect('deadline_at <= clock_timestamp()', 'expired')
		.addSelect('next_attempt_at > clock_timestamp()', 'future')
		.from('backend_internal.work_item', 'item').where('work_id = :workId', { workId })
		.setLock('pessimistic_write').getRawOne<ItemRow>();
	if (!note || !item) {
		return null;
	}
	const request = await manager.createQueryBuilder().select('request.*')
		.addSelect('not_before > clock_timestamp()', 'future').from('backend_internal.work_request', 'request')
		.where('request_id = :requestId', { requestId: item.request_id }).getRawOne<RequestRow>();
	return request && request.note_id === note.note_id ? { note, item, request } : null;
}

function cancelled(note: NoteRow, request: RequestRow): boolean {
	return request.note_generation === 1 && (note.generation !== 1 || note.deleted_at !== null);
}

async function terminate(manager: EntityManager, item: ItemRow, state: string, reason: string) {
	await settleLocalItem(manager, item.work_id, state, reason);
	await aggregateLocalRequest(manager, item.request_id);
}

export class PostWorkLocalExecutionStore {
	private readonly validation = new LocalWorkValidationCache();

	constructor(private readonly source: DataSource, private readonly random: () => number = Math.random) {}

	async claim(input: unknown, owner: string): Promise<LocalExecutionClaim | null> {
		if (!validText(owner, 128)) {
			throw new Error('Invalid execution owner');
		}
		if (!envelope(input) || !localKinds.includes(input.kind)) {
			return null;
		}
		return this.source.transaction(async manager => {
			const locked = await lockLocalItem(manager, input.workId);
			if (!locked) {
				return null;
			}
			const { item, request, note } = locked;
			if (item.kind !== input.kind || item.schema_version !== input.schemaVersion || !activeLocalStates.includes(item.state) || item.active) {
				return null;
			}
			const validated = this.validation.validate(item, request);
			const queues = item.kind === 'ap.expand' ? ['deliver', 'postLocal'] : ['postLocal'];
			const controls = await manager.createQueryBuilder().select('control.*').from('backend_internal.work_control', 'control')
				.where('queue_key IN (:...queues)', { queues }).orderBy('queue_key').setLock('pessimistic_read')
				.getRawMany<{ queue_key: string; queue_generation: string; paused: boolean }>();
			const control = controls.find(value => value.queue_key === 'postLocal');
			if (controls.length !== queues.length || !control) {
				throw new Error('Missing work queue control');
			}
			const transport = await manager.createQueryBuilder().select('dispatch.work_id').from('backend_internal.queue_dispatch', 'dispatch')
				.where('work_id = :workId AND dispatch_seq = :seq AND queue_generation = :generation AND queue_key = \'postLocal\'', {
					workId: input.workId, seq: input.dispatchSeq, generation: input.queueGeneration,
				}).andWhere('state IN (\'reserved\',\'enqueue_unknown\',\'enqueued\')').getRawOne();
			if (!transport || control.queue_generation !== input.queueGeneration) {
				return null;
			}
			if (!validated) {
				await terminate(manager, item, 'quarantined', 'invalid_payload');
				return null;
			}
			if (item.expired || item.attempt_count >= 8) {
				await terminate(manager, item, 'exhausted', item.expired ? 'deadline_exceeded' : 'attempts_exhausted');
				return null;
			}
			if (cancelled(note, request)) {
				await terminate(manager, item, 'cancelled', 'note_cancelled');
				return null;
			}
			if (item.future || request.future) {
				return null;
			}
			if (controls.some(value => value.paused)) {
				await manager.createQueryBuilder().update('backend_internal.work_item').set({
					state: 'retry_wait', reason_code: 'paused', execution_owner: null, execution_until: null,
					next_attempt_at: () => 'LEAST(clock_timestamp() + interval \'30 seconds\', deadline_at)',
				}).where('work_id = :workId', { workId: item.work_id }).execute();
				return null;
			}
			const updated = await manager.createQueryBuilder().update('backend_internal.work_item').set({
				state: 'running', attempt_count: () => 'attempt_count + 1', execution_owner: owner,
				execution_epoch: () => 'execution_epoch + 1', execution_until: () => 'clock_timestamp() + interval \'60 seconds\'',
				reason_code: null, reason_summary: null,
			}).where('work_id = :workId', { workId: item.work_id })
				.andWhere('(execution_until IS NULL OR execution_until <= clock_timestamp())')
				.andWhere('deadline_at > clock_timestamp() AND next_attempt_at <= clock_timestamp() AND attempt_count < 8')
				.returning(['execution_epoch', 'attempt_count']).execute();
			if (updated.affected !== 1) {
				return null;
			}
			return {
				workId: item.work_id, requestId: item.request_id, noteId: note.note_id,
				kind: item.kind as LocalExecutionClaim['kind'], owner, epoch: updated.raw[0].execution_epoch,
				attempt: updated.raw[0].attempt_count, deadlineAtMs: item.deadline_at.getTime(), ...validated,
			};
		});
	}

	async renew(claim: LocalExecutionClaim): Promise<boolean> {
		return this.source.transaction(async manager => {
			// A row lock can outlive the lease without changing the row; test time in a fresh statement after acquiring it.
			await manager.createQueryBuilder().select('item.work_id').from('backend_internal.work_item', 'item')
				.where('work_id = :workId', { workId: claim.workId }).setLock('pessimistic_write').getRawOne();
			const result = await manager.createQueryBuilder().update('backend_internal.work_item')
				.set({ execution_until: () => 'clock_timestamp() + interval \'60 seconds\'' })
				.where('work_id = :workId AND execution_owner = :owner AND execution_epoch = :epoch AND state = \'running\'', claim)
				.andWhere('execution_until > clock_timestamp() AND deadline_at > clock_timestamp()')
				.andWhere('kind IN (:...kinds)', { kinds: localKinds }).execute();
			return result.affected === 1;
		});
	}

	async finish(claim: LocalExecutionClaim, outcome: LocalWorkOutcome): Promise<void> {
		await this.source.transaction(manager => withLocalWorkCompletion(manager, claim, async () => outcome, this.random));
	}

	async expire(limit = 100): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error('Invalid execution recovery batch size');
		}
		const candidates = await this.source.createQueryBuilder().select('item.work_id', 'work_id')
			.from('backend_internal.work_item', 'item').where('kind IN (:...kinds)', { kinds: localKinds })
			.andWhere('state IN (:...states)', { states: activeLocalStates })
			.andWhere('(execution_until IS NULL OR execution_until <= clock_timestamp())')
			.andWhere('(deadline_at <= clock_timestamp() OR attempt_count >= 8)')
			.orderBy('deadline_at').addOrderBy('work_id').limit(limit).getRawMany<{ work_id: string }>();
		let settled = 0;
		for (const candidate of candidates) {
			settled += await this.source.transaction(async manager => {
				const locked = await lockLocalItem(manager, candidate.work_id);
				if (!locked || !localKinds.includes(locked.item.kind) || !activeLocalStates.includes(locked.item.state)
					|| locked.item.active || (!locked.item.expired && locked.item.attempt_count < 8)) {
					return 0;
				}
				await terminate(manager, locked.item, 'exhausted', locked.item.expired ? 'deadline_exceeded' : 'attempts_exhausted');
				return 1;
			});
		}
		return settled;
	}
}

/** Locks note/item before invoking result writes bound to the same caller-owned transaction. */
export async function withLocalWorkCompletion(
	manager: EntityManager,
	claim: LocalExecutionClaim,
	work: () => Promise<LocalWorkOutcome>,
	random: () => number = Math.random,
): Promise<void> {
	if (!manager.queryRunner?.isTransactionActive || manager.queryRunner.isReleased) {
		throw new Error('Local work completion requires an active transaction');
	}
	const locked = await lockLocalItem(manager, claim.workId);
	if (!locked || locked.item.state !== 'running' || locked.item.execution_owner !== claim.owner
		|| locked.item.execution_epoch !== claim.epoch || !locked.item.active || locked.item.expired
		|| locked.item.request_id !== claim.requestId || locked.note.note_id !== claim.noteId
		|| locked.item.kind !== claim.kind || !localKinds.includes(locked.item.kind) || cancelled(locked.note, locked.request)) {
		throw new LostLocalExecution();
	}
	const outcome = await work();
	if (!['succeeded', 'skipped', 'cancelled', 'failed_permanent', 'retry'].includes(outcome.status)
		|| (outcome.status === 'succeeded' ? outcome.resultRef !== undefined && !validText(outcome.resultRef, 128)
		: !validText(outcome.reason, 64) || !/^[a-z][a-z0-9_]*$/.test(outcome.reason))) {
		throw new Error('Invalid local execution outcome');
	}
	let state: string = outcome.status;
	let next: Date | undefined;
	if (outcome.status === 'retry') {
		const jitter = random();
		if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
			throw new Error('Invalid retry jitter');
		}
		const row = await manager.createQueryBuilder().select('clock_timestamp()', 'now')
			.from('backend_internal.work_item', 'item').where('work_id = :workId', { workId: claim.workId }).getRawOne<{ now: Date }>();
		if (!row) {
			throw new LostLocalExecution();
		}
		next = new Date(row.now.getTime() + Math.min(60000 * 2 ** (locked.item.attempt_count - 1), 3600000) * (1 + 0.2 * jitter));
		state = locked.item.attempt_count >= 8 || next.getTime() >= locked.item.deadline_at.getTime() ? 'exhausted' : 'retry_wait';
	}
	const result = await manager.createQueryBuilder().update('backend_internal.work_item').set({
		state, next_attempt_at: state === 'retry_wait' ? next : undefined,
		reason_code: outcome.status === 'succeeded' ? null : outcome.reason,
		last_outcome: outcome.status === 'retry' ? 'retryable_failure' : outcome.status,
		result_ref: outcome.status === 'succeeded' ? outcome.resultRef ?? null : null,
		execution_owner: null, execution_until: null,
		finished_at: state === 'retry_wait' ? null : () => 'clock_timestamp()',
	}).where('work_id = :workId AND execution_owner = :owner AND execution_epoch = :epoch AND state = \'running\'', claim)
		.andWhere('execution_until > clock_timestamp() AND deadline_at > clock_timestamp()').execute();
	if (result.affected !== 1) {
		throw new LostLocalExecution();
	}
	if (state !== 'retry_wait') {
		await aggregateLocalRequest(manager, claim.requestId);
	}
}
