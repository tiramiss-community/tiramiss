/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { workHash } from '../../../modules/post-work/prepare.js';
import { parsePagePayload } from './page-payload.js';
import type { LocalWorkValidationCache, SavedLocalRequest } from '../post-work/local-work-validation.js';
import type { ApWorkRequest } from '../../../modules/post-work/public.js';
import type { EntityManager } from 'typeorm';

interface PageItem {
	work_id: string; request_id: string; kind: string; target_key: string; state: string;
	schema_version: number; payload: string | null; payload_hash: string; deadline_at: Date;
}

export interface RecipientRow {
	inbox: string; shared: boolean; create_event_id: string; request_id: string;
	note_id: string; actor_id: string; activity_id: string;
}

export function recipientPage(manager: EntityManager, requestId: string, after: string | null): Promise<RecipientRow[]> {
	const query = manager.createQueryBuilder().select('recipient.*').from('backend_internal.delivery_recipient', 'recipient')
		.where('request_id=:requestId', { requestId });
	if (after !== null) {
		query.andWhere('inbox>:after', { after });
	}
	return query.orderBy('inbox').limit(101).getRawMany<RecipientRow>();
}

export function recipientsMatch(rows: RecipientRow[], request: ApWorkRequest): boolean {
	return rows.length > 0 && rows.every(row => row.create_event_id === request.eventId && row.request_id === request.requestId
		&& row.note_id === request.noteId && row.actor_id === request.actorId && row.activity_id === request.payload.activity.id);
}

export async function validateApPage(
	manager: EntityManager,
	item: PageItem,
	saved: SavedLocalRequest,
	validation: LocalWorkValidationCache,
): Promise<boolean> {
	const validated = validation.validate(item, saved);
	if (!validated || validated.request.kind !== 'ap.expand' || validated.request.noteGeneration !== 1
		|| item.work_id !== workHash(JSON.stringify([saved.request_id, 'ap.expand.page', item.target_key]))) {
		return false;
	}
	const request = validated.request;
	const page = item.payload && parsePagePayload(item.payload, item.target_key);
	if (!page) {
		return false;
	}
	const note = await manager.createQueryBuilder().select('note.recipient_coverage', 'coverage')
		.from('backend_internal.note_work_state', 'note').where('note_id=:id', { id: saved.note_id }).getRawOne<{ coverage: string }>();
	const root = await manager.createQueryBuilder().select('item.*').from('backend_internal.work_item', 'item')
		.where('work_id=:id AND request_id=:request', {
			id: workHash(JSON.stringify([saved.request_id, 'ap.expand', 'all'])), request: saved.request_id,
		}).getRawOne<PageItem>();
	if (note?.coverage !== 'fixed' || !root || root.kind !== 'ap.expand' || root.state !== 'succeeded'
		|| !validation.validate(root, saved)) {
		return false;
	}

	if (page.after !== null) {
		const previous = await manager.createQueryBuilder().select('item.*').from('backend_internal.work_item', 'item')
			.where('work_id=:id AND request_id=:request', { id: page.previous, request: saved.request_id }).getRawOne<PageItem>();
		if (!previous || previous.kind !== 'ap.expand.page' || previous.state !== 'succeeded'
			|| previous.work_id !== workHash(JSON.stringify([saved.request_id, 'ap.expand.page', previous.target_key]))
			|| !validation.validate(previous, saved)) {
			return false;
		}
		const before = previous.payload && parsePagePayload(previous.payload, previous.target_key);
		if (!before) {
			return false;
		}
		// A successful predecessor proves the prior batch committed. Re-read only its boundary, never the whole chain.
		const boundary = await recipientPage(manager, saved.request_id, before.after);
		if (boundary.length !== 101 || boundary[99].inbox !== page.after || !recipientsMatch(boundary, request)) {
			return false;
		}
	}
	return recipientsMatch(await recipientPage(manager, saved.request_id, page.after), request);
}
