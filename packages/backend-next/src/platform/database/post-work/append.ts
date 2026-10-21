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
	const rows: { request_id: string; matches: boolean }[] = await manager.query(`
		SELECT request_id, (
			event_id=$2 AND kind=$3 AND note_generation=$4 AND note_id=$5 AND actor_id=$6
			AND schema_version=$7 AND payload=$8 AND payload_hash=$9 AND note_facts=$10::jsonb
			AND occurred_at=$11 AND not_before=$12 AND deadline_at=$13
		) AS matches FROM backend_internal.work_request
		WHERE request_id=$1 OR (event_id=$2 AND kind=$3 AND note_generation=$4)
		ORDER BY request_id FOR UPDATE`, [
		request.requestId, request.eventId, request.kind, request.noteGeneration, request.noteId, request.actorId,
		request.schemaVersion, payloadJson, hash, noteJson,
		new Date(request.occurredAtMs), new Date(request.notBeforeMs), new Date(deadlineAtMs),
	]);
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
	const insertedNote: { note_id: string }[] = await manager.query(`
		INSERT INTO backend_internal.note_work_state
		(note_id,actor_id,generation,create_event_id,cancel_event_id,visibility,local_only,channel_id,
		 deleted_at,recipient_coverage,last_dependency_at,charged_bytes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT DO NOTHING RETURNING note_id`, [
		request.noteId, request.actorId, request.noteGeneration, deleting ? null : request.eventId, deleting ? request.eventId : null,
		request.note.visibility, request.note.localOnly, request.note.channelId,
		deleting ? new Date(request.occurredAtMs) : null, deleting ? 'unavailable' : 'not_started', new Date(request.occurredAtMs), noteCharge,
	]);
	const [note]: NoteState[] = await manager.query('SELECT * FROM backend_internal.note_work_state WHERE note_id=$1 FOR UPDATE', [request.noteId]);
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
			await manager.query(`UPDATE backend_internal.note_work_state SET generation=2,cancel_event_id=$2,deleted_at=$3
				WHERE note_id=$1`, [request.noteId, request.eventId, new Date(request.occurredAtMs)]);
		} else if (insertedNote.length !== 1) {
			// Retained cancellation state cannot be used to regenerate a discarded request.
			conflict();
		}
	} else if (note.generation !== 1 || note.create_event_id !== request.eventId) {
		conflict();
	}

	const requestCharge = chargedBytes(1024,
		request.requestId + request.eventId + request.noteId + request.actorId + request.kind + noteJson + payloadJson);
	const inserted: { request_id: string }[] = await manager.query(`
		INSERT INTO backend_internal.work_request
		(request_id,event_id,note_id,actor_id,note_generation,kind,schema_version,note_facts,payload,payload_hash,
		 occurred_at,not_before,deadline_at,charged_bytes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT DO NOTHING RETURNING request_id`, [
		request.requestId, request.eventId, request.noteId, request.actorId, request.noteGeneration, request.kind,
		request.schemaVersion, noteJson, payloadJson, hash,
		new Date(request.occurredAtMs), new Date(request.notBeforeMs), new Date(deadlineAtMs), requestCharge,
	]);
	if (inserted.length !== 1) {
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
	const rows = insertedNote.length + 1 + items.length;
	const bytes = insertedNote.length * noteCharge + requestCharge + items.reduce((sum, item) => sum + item.charged_bytes, 0);
	const fraction = deleting ? 1 : 0.9;
	const reserved: { capacity_key: string }[] = await manager.query(`
		WITH reserved AS (
			UPDATE backend_internal.work_capacity SET reserved_rows=reserved_rows+$1,reserved_bytes=reserved_bytes+$2
			WHERE capacity_key='global' AND capacity_formula_version=$3
			AND reserved_rows+$1 <= $4 AND reserved_bytes+$2 <= $5 RETURNING capacity_key
		) SELECT capacity_key FROM reserved`, [rows, bytes, workCapacity.formulaVersion, workCapacity.rows * fraction, Math.floor(workCapacity.bytes * fraction)]);
	if (reserved.length !== 1) {
		throw new WorkCapacityExceeded('The durable work capacity is full or requires reconciliation');
	}

	for (let offset = 0; offset < items.length; offset += 100) {
		await manager.query(`
			INSERT INTO backend_internal.work_item
			(work_id,request_id,kind,target_key,schema_version,payload,payload_hash,next_attempt_at,deadline_at,charged_bytes)
			SELECT item.work_id,$2,item.kind,item.target_key,$3,item.payload,item.payload_hash,$4,$5,item.charged_bytes
			FROM jsonb_to_recordset($1::jsonb) AS item
			(work_id text,kind text,target_key text,payload text,payload_hash text,charged_bytes bigint)`, [
			JSON.stringify(items.slice(offset, offset + 100)), request.requestId, request.schemaVersion,
			new Date(request.notBeforeMs), new Date(deadlineAtMs),
		]);
	}
	await manager.query('UPDATE backend_internal.note_work_state SET last_dependency_at=GREATEST(last_dependency_at,$2) WHERE note_id=$1', [request.noteId, new Date(request.occurredAtMs)]);
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
