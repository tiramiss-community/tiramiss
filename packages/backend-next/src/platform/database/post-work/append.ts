/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EntityManager } from 'typeorm';
import { WorkCapacityExceeded, WorkRequestConflict } from '../../../modules/post-work/public.js';
import type { PostWorkRequests } from '../../../modules/post-work/public.js';
import { chargedBytes, preparePostWork, workCapacity, workHash } from '../../../modules/post-work/prepare.js';

type Prepared = ReturnType<typeof preparePostWork>;
interface NoteState {
	actor_id: string;
	generation: number;
	create_event_id: string | null;
	cancel_event_id: string | null;
	visibility: string;
	local_only: boolean;
	channel_id: string | null;
}

function conflict(): never {
	throw new WorkRequestConflict('The immutable work identity or content does not match');
}

async function existingRequest(manager: EntityManager, prepared: Prepared): Promise<string | null> {
	const { request, payloadJson, noteJson, hash, deadlineAtMs } = prepared;
	const rows = await manager.createQueryBuilder()
		.select('request.request_id', 'request_id')
		.addSelect(`(
			event_id=:eventId AND kind=:kind AND note_generation=:generation AND note_id=:noteId AND actor_id=:actorId
			AND schema_version=:version AND payload=:payload AND payload_hash=:hash AND note_facts=CAST(:note AS jsonb)
			AND occurred_at=:occurredAt AND not_before=:notBefore AND deadline_at=:deadline
		)`, 'matches')
		.from('backend_internal.work_request', 'request')
		.where('request_id=:requestId')
		.orWhere('(event_id=:eventId AND kind=:kind AND note_generation=:generation)')
		.orderBy('request.request_id')
		.setLock('pessimistic_write')
		.setParameters({
			requestId: request.requestId, eventId: request.eventId, kind: request.kind, generation: request.noteGeneration,
			noteId: request.noteId, actorId: request.actorId, version: request.schemaVersion,
			payload: payloadJson, hash, note: noteJson,
			occurredAt: new Date(request.occurredAtMs), notBefore: new Date(request.notBeforeMs), deadline: new Date(deadlineAtMs),
		})
		.getRawMany<{ request_id: string; matches: boolean }>();
	if (rows.length === 0) {
		return null;
	}
	if (rows.length !== 1 || rows[0].matches !== true) {
		conflict();
	}
	return rows[0].request_id;
}

async function append(manager: EntityManager, prepared: Prepared): Promise<{ requestId: string }> {
	const { request, payloadJson, noteJson, hash, deadlineAtMs, deleting } = prepared;
	// Both event slots are reserved at their maximum width so cancellation never grows this row's charge.
	const noteCharge = chargedBytes(256, request.noteId + request.actorId + 'x'.repeat(256) + JSON.stringify(request.note));
	const insertedNote = await manager.createQueryBuilder().insert()
		.into('backend_internal.note_work_state')
		.values({
			note_id: request.noteId, actor_id: request.actorId, generation: request.noteGeneration,
			create_event_id: deleting ? null : request.eventId, cancel_event_id: deleting ? request.eventId : null,
			visibility: request.note.visibility, local_only: request.note.localOnly, channel_id: request.note.channelId,
			deleted_at: deleting ? new Date(request.occurredAtMs) : null,
			recipient_coverage: deleting ? 'unavailable' : 'not_started',
			last_dependency_at: new Date(request.occurredAtMs), charged_bytes: noteCharge,
		})
		.orIgnore().returning('note_id').execute();
	const note = await manager.createQueryBuilder().select('note.*')
		.from('backend_internal.note_work_state', 'note')
		.where('note_id=:noteId', { noteId: request.noteId })
		.setLock('pessimistic_write').getRawOne<NoteState>();
	if (!note || note.actor_id !== request.actorId || note.visibility !== request.note.visibility
		|| note.local_only !== request.note.localOnly || note.channel_id !== request.note.channelId) {
		conflict();
	}
	const existing = await existingRequest(manager, prepared);
	if (existing !== null) {
		return { requestId: existing };
	}
	if (deleting) {
		if (note.generation === 1 && note.create_event_id !== request.eventId) {
			await manager.createQueryBuilder().update('backend_internal.note_work_state')
				.set({ generation: 2, cancel_event_id: request.eventId, deleted_at: new Date(request.occurredAtMs) })
				.where('note_id=:noteId', { noteId: request.noteId }).execute();
		} else if (insertedNote.raw.length !== 1) {
			// Retained cancellation state cannot be used to regenerate a discarded request.
			conflict();
		}
	} else if (note.generation !== 1 || note.create_event_id !== request.eventId) {
		conflict();
	}

	const requestCharge = chargedBytes(1024,
		request.requestId + request.eventId + request.noteId + request.actorId + request.kind + noteJson + payloadJson);
	const inserted = await manager.createQueryBuilder().insert()
		.into('backend_internal.work_request')
		.values({
			request_id: request.requestId, event_id: request.eventId, note_id: request.noteId, actor_id: request.actorId,
			note_generation: request.noteGeneration, kind: request.kind, schema_version: request.schemaVersion,
			note_facts: request.note, payload: payloadJson, payload_hash: hash,
			occurred_at: new Date(request.occurredAtMs), not_before: new Date(request.notBeforeMs),
			deadline_at: new Date(deadlineAtMs), charged_bytes: requestCharge,
		})
		.orIgnore().returning('request_id').execute();
	if (inserted.raw.length !== 1) {
		// Different note locks may still collide on a global request/event key.
		const canonical = await existingRequest(manager, prepared);
		if (canonical === null) {
			conflict();
		}
		return { requestId: canonical };
	}

	const items = prepared.items.map(item => {
		const workId = workHash(JSON.stringify([request.requestId, item.kind, item.targetKey]));
		const payload = JSON.stringify(item.payload);
		return {
			work_id: workId, kind: item.kind, target_key: item.targetKey, payload, payload_hash: workHash(payload),
			charged_bytes: chargedBytes(1536, workId + request.requestId + item.kind + item.targetKey + payload),
		};
	});
	const rows = insertedNote.raw.length + 1 + items.length;
	const bytes = insertedNote.raw.length * noteCharge + requestCharge + items.reduce((sum, item) => sum + item.charged_bytes, 0);
	const fraction = deleting ? 1 : 0.9;
	const reserved = await manager.createQueryBuilder().update('backend_internal.work_capacity')
		.set({ reserved_rows: () => 'reserved_rows + :rows', reserved_bytes: () => 'reserved_bytes + :bytes' })
		.where('capacity_key=:key AND capacity_formula_version=:version')
		.andWhere('reserved_rows + :rows <= :rowLimit AND reserved_bytes + :bytes <= :byteLimit')
		.setParameters({
			key: 'global', version: workCapacity.formulaVersion, rows, bytes,
			rowLimit: workCapacity.rows * fraction, byteLimit: Math.floor(workCapacity.bytes * fraction),
		}).execute();
	if (reserved.affected !== 1) {
		throw new WorkCapacityExceeded('The durable work capacity is full or requires reconciliation');
	}

	for (let offset = 0; offset < items.length; offset += 100) {
		await manager.createQueryBuilder().insert().into('backend_internal.work_item')
			.values(items.slice(offset, offset + 100).map(item => ({
				...item, request_id: request.requestId, schema_version: request.schemaVersion,
				next_attempt_at: new Date(request.notBeforeMs), deadline_at: new Date(deadlineAtMs),
			}))).execute();
	}
	await manager.createQueryBuilder().update('backend_internal.note_work_state')
		.set({ last_dependency_at: () => 'GREATEST(last_dependency_at, :occurredAt)' })
		.where('note_id=:noteId', { noteId: request.noteId })
		.setParameter('occurredAt', new Date(request.occurredAtMs)).execute();
	return { requestId: request.requestId };
}

export async function withPostWorkRequests<T>(
	manager: EntityManager,
	work: (requests: PostWorkRequests) => Promise<T>,
): Promise<T> {
	const runner = manager.queryRunner;
	if (!runner?.isTransactionActive || runner.isReleased) {
		throw new Error('Post work requires an active transaction');
	}
	let accepting = true;
	let rejected = false;
	let failure: unknown;
	const pending = new Set<Promise<{ requestId: string }>>();
	const requests: PostWorkRequests = {
		append: request => {
			if (!accepting || !runner.isTransactionActive || runner.isReleased) {
				return Promise.reject(new Error('The post work transaction scope has ended'));
			}
			if (rejected) {
				return Promise.reject(failure);
			}
			const operation = (async () => append(manager, preparePostWork(request)))();
			pending.add(operation);
			void operation.then(() => pending.delete(operation), error => {
				pending.delete(operation);
				if (!rejected) {
					rejected = true;
					failure = error;
				}
			});
			return operation;
		},
	};
	try {
		const result = await work(requests);
		accepting = false;
		await Promise.allSettled(pending);
		if (rejected) {
			throw failure;
		}
		return result;
	} finally {
		accepting = false;
		// A started write must finish before the caller can commit, roll back or release this connection.
		await Promise.allSettled(pending);
	}
}
