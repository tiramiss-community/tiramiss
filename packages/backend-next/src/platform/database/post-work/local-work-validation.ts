/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { isDeepStrictEqual } from 'node:util';
import { parsePagePayload } from '../ap/page-payload.js';
import { preparePostWork, workHash } from '../../../modules/post-work/prepare.js';
import type { PostWorkRequest } from '../../../modules/post-work/public.js';

export interface SavedLocalRequest {
	request_id: string; event_id: string; note_id: string; actor_id: string; note_generation: number;
	kind: string; schema_version: number; note_facts: unknown; payload: string | null; payload_hash: string;
	occurred_at: Date; not_before: Date; deadline_at: Date;
}
interface SavedLocalItem {
	kind: string; schema_version: number; target_key: string;
	payload: string | null; payload_hash: string; deadline_at: Date;
}
const maxRequests = 4;
const sourceByteLimit = 4 * 1024 * 1024;

interface ValidatedRequest {
	request: PostWorkRequest;
	deadlineAtMs: number;
	targets: Map<string, unknown>;
}
interface Entry {
	metadata: string;
	payload: string | null;
	hash: string;
	bytes: number;
	validated: ValidatedRequest | null;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) {
			freeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

function validateRequest(saved: SavedLocalRequest): ValidatedRequest | null {
	try {
		if (saved.schema_version !== 1 || !saved.payload) {
			return null;
		}
		const prepared = preparePostWork({
			requestId: saved.request_id, eventId: saved.event_id, noteId: saved.note_id, actorId: saved.actor_id,
			note: saved.note_facts, noteGeneration: saved.note_generation, kind: saved.kind, schemaVersion: saved.schema_version,
			occurredAtMs: saved.occurred_at.getTime(), notBeforeMs: saved.not_before.getTime(), payload: JSON.parse(saved.payload),
		});
		if (prepared.payloadJson !== saved.payload || prepared.hash !== saved.payload_hash
			|| prepared.deadlineAtMs !== saved.deadline_at.getTime()) {
			return null;
		}
		return {
			request: freeze(prepared.request), deadlineAtMs: prepared.deadlineAtMs,
			targets: new Map(prepared.items.map(item => [JSON.stringify([item.kind, item.targetKey]), item.payload])),
		};
	} catch {
		return null;
	}
}

export class LocalWorkValidationCache {
	private readonly entries = new Map<string, Entry>();
	private bytes = 0;

	validate(item: SavedLocalItem, saved: SavedLocalRequest) {
		try {
			if (item.schema_version !== 1 || !item.payload || workHash(item.payload) !== item.payload_hash) {
				return null;
			}
			const metadata = JSON.stringify([
				saved.request_id, saved.event_id, saved.note_id, saved.actor_id, saved.note_generation,
				saved.kind, saved.schema_version, saved.note_facts,
				saved.occurred_at.getTime(), saved.not_before.getTime(), saved.deadline_at.getTime(),
			]);
			let entry = this.entries.get(saved.request_id);
			// Compare exact saved content, not just its hash; corruption with an unchanged hash must invalidate the entry.
			if (!entry || entry.metadata !== metadata || entry.payload !== saved.payload || entry.hash !== saved.payload_hash) {
				this.remove(saved.request_id);
				entry = {
					metadata, payload: saved.payload, hash: saved.payload_hash,
					bytes: Buffer.byteLength(metadata) + Buffer.byteLength(saved.payload ?? ''), validated: validateRequest(saved),
				};
				// Bound retained source data and candidate indexes by both request count and serialized size.
				for (const key of this.entries.keys()) {
					if (this.entries.size < maxRequests && this.bytes + entry.bytes <= sourceByteLimit) {
						break;
					}
					this.remove(key);
				}
				if (entry.bytes <= sourceByteLimit) {
					this.entries.set(saved.request_id, entry);
					this.bytes += entry.bytes;
				}
			} else {
				this.entries.delete(saved.request_id);
				this.entries.set(saved.request_id, entry);
			}
			const validated = entry.validated;
			const payload = JSON.parse(item.payload) as Record<string, unknown>;
			const page = item.kind === 'ap.expand.page' && validated?.request.kind === 'ap.expand'
				&& validated.request.noteGeneration === 1 ? parsePagePayload(item.payload, item.target_key) : null;
			const expected = page ?? validated?.targets.get(JSON.stringify([item.kind, item.target_key]));
			if (!validated || expected === undefined || !isDeepStrictEqual(expected, payload)
				|| item.deadline_at.getTime() !== validated.deadlineAtMs) {
				return null;
			}
			return { request: validated.request, payload };
		} catch {
			return null;
		}
	}

	private remove(key: string): void {
		const previous = this.entries.get(key);
		if (previous) {
			this.bytes -= previous.bytes;
			this.entries.delete(key);
		}
	}
}
