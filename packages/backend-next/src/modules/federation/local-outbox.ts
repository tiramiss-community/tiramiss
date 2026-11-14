/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { apContext } from './ap-context.js';
import type { NotePublicationRow } from './local-featured.js';

export interface OutboxBounds { sinceId: string | null; untilId: string | null }
export interface OutboxCandidate {
	note: NotePublicationRow;
	authorSuspended: boolean;
	replyUserId: string | null;
	replyUserHost: string | null;
	renoteUserId: string | null;
	replyAuthorSuspended: boolean;
	renoteAuthorSuspended: boolean;
}
export interface OutboxPolicy {
	blockedHosts: readonly string[];
	ugcVisibilityForVisitor: 'all' | 'local' | 'none';
}
export interface OutboxReader {
	readLocalUser(id: string): Promise<{ id: string; notesCount: number } | null>;
	readDbPage(userId: string, bounds: OutboxBounds, limit: number): Promise<NotePublicationRow[]>;
	readTimelineIds(userId: string): Promise<string[][]>;
	readCandidates(ids: string[]): Promise<OutboxCandidate[]>;
}
export function outboxCandidateVisible(candidate: OutboxCandidate, policy: OutboxPolicy): boolean {
	const { note, replyUserId, renoteUserId } = candidate;
	const blocked = (host: string | null) => host != null && policy.blockedHosts.some(value => `.${host.toLowerCase()}`.endsWith(`.${value}`));
	if (candidate.authorSuspended || blocked(note.userHost)) {
		return false;
	}
	if (note.userId !== renoteUserId && (candidate.renoteAuthorSuspended || blocked(note.renoteUserHost))) {
		return false;
	}
	if (note.userId !== replyUserId && (candidate.replyAuthorSuspended || blocked(candidate.replyUserHost))) {
		return false;
	}
	if (policy.ugcVisibilityForVisitor === 'none' || policy.ugcVisibilityForVisitor === 'local' && note.userHost !== null) {
		return false;
	}
	return !note.localOnly && (note.visibility === 'public' || note.visibility === 'home');
}
/** Anonymous outbox's fixed two-list fanout contract; DB fallback intentionally bypasses cache filters. */
export async function readOutboxNotes(userId: string, bounds: OutboxBounds, fanout: boolean, policy: OutboxPolicy, reader: Pick<OutboxReader, 'readDbPage' | 'readTimelineIds' | 'readCandidates'>): Promise<NotePublicationRow[]> {
	const limit = 20;
	if (!fanout) {
		return reader.readDbPage(userId, bounds, limit);
	}
	const ascending = Boolean(bounds.sinceId && !bounds.untilId);
	const compare = ascending ? (a: string, b: string) => a < b ? -1 : 1 : (a: string, b: string) => a > b ? -1 : 1;
	const lists = await reader.readTimelineIds(userId);
	const ids = [...new Set(lists.flat().filter(id => (!bounds.untilId || id < bounds.untilId) && (!bounds.sinceId || id > bounds.sinceId)))].sort(compare);
	const oldest = ascending ? ids[0] : ids.at(-1)!;
	if (ids.length === 0 || bounds.sinceId !== null && bounds.sinceId < oldest) {
		return reader.readDbPage(userId, bounds, limit);
	}
	const result: NotePublicationRow[] = [];
	let consumed = 0;
	let rate = 1;
	while (consumed < ids.length) {
		const count = Math.ceil((limit - result.length) * Math.min(1.1 / rate, 3));
		const batch = ids.slice(consumed, consumed + count);
		consumed += batch.length;
		const found = (await reader.readCandidates(batch)).filter(candidate => outboxCandidateVisible(candidate, policy)).map(candidate => candidate.note).sort((a, b) => compare(a.id, b.id));
		result.push(...found);
		rate = found.length / batch.length;
		if (result.length >= limit) {
			return result.slice(0, limit);
		}
	}
	const last = ids[consumed - 1];
	return [...result, ...await reader.readDbPage(userId, ascending ? { ...bounds, sinceId: last } : { ...bounds, untilId: last }, limit - result.length)];
}
export function renderOutboxCollection(userId: string, notesCount: number, page: { bounds: OutboxBounds; notes: Pick<NotePublicationRow, 'id'>[]; activities: Record<string, unknown>[] } | null, selfUrl: string): Record<string, unknown> {
	const base = `${selfUrl}/users/${userId}/outbox`;
	if (page === null) {
		return { '@context': apContext, id: base, type: 'OrderedCollection', totalItems: notesCount, first: `${base}?page=true`, last: `${base}?page=true&since_id=000000000000000000000000` };
	}
	const url = (bounds: OutboxBounds) => `${base}?page=true${bounds.sinceId === null ? '' : `&since_id=${encodeURIComponent(bounds.sinceId)}`}${bounds.untilId === null ? '' : `&until_id=${encodeURIComponent(bounds.untilId)}`}`;
	return {
		'@context': apContext, id: url(page.bounds), type: 'OrderedCollectionPage', totalItems: notesCount, partOf: base,
		prev: page.notes.length ? url({ sinceId: page.notes[0].id, untilId: null }) : undefined,
		next: page.notes.length ? url({ sinceId: null, untilId: page.notes.at(-1)!.id }) : undefined,
		orderedItems: page.activities,
	};
}
