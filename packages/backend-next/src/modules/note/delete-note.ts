/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { NoteDeleteError, readDeletionRequest } from './deletion-request.js';
import { isPureRenote } from '../federation/public.js';
import type { NoteCreateActor } from './create-contract.js';
import type { NoteActivityNote } from '../federation/public.js';

export { NoteDeleteError } from './deletion-request.js';
export type { NoteDeleteErrorCode } from './deletion-request.js';

export interface DeletedNoteSnapshot {
	id: string;
	userId: string;
	authorHost: string | null;
	noteHost: string | null;
	authorUsername: string;
	localOnly: boolean;
	replyId: string | null;
	renoteUserId: string | null;
	note: NoteActivityNote;
	renote: { id: string; uri: string | null } | null;
	auditNote: Record<string, unknown>;
}
export type NoteDeleteWork =
 | { kind: 'charts'; snapshot: DeletedNoteSnapshot }
 | { kind: 'instanceCounts'; snapshot: DeletedNoteSnapshot }
 | { kind: 'search'; snapshot: DeletedNoteSnapshot }
 | { kind: 'delivery'; snapshot: DeletedNoteSnapshot; activity: Record<string, unknown> }
 | { kind: 'stream'; snapshot: DeletedNoteSnapshot; occurredAtMs: number }
 | { kind: 'audit'; snapshot: DeletedNoteSnapshot; actorId: string; occurredAtMs: number };

export type NoteDeletionPorts = {
	readActor(userId: string, now: number): Promise<{ isSuspended: boolean; rateLimitFactor: number; isModerator: boolean } | null>;
	limit(userId: string, factor: number): Promise<void>;
	readNote(id: string): Promise<DeletedNoteSnapshot | null>;
	readRenote(id: string): Promise<DeletedNoteSnapshot['renote']>;
	decrementReplies(noteId: string): Promise<void>;
	publishDeleted?(snapshot: DeletedNoteSnapshot, deletedAt: number): void;
	renderActivity(snapshot: DeletedNoteSnapshot, now: number): Record<string, unknown>;
	start(work: NoteDeleteWork): void;
	deleteNote(noteId: string, authorId: string): Promise<void>;
};

export async function removeNote(snapshot: DeletedNoteSnapshot, actorId: string, now: number, ports: NoteDeletionPorts): Promise<void> {
	// 本家はこの減算を独立した文として先に確定する。後の DELETE 失敗で巻き戻したことにはしない。
	if (snapshot.replyId !== null) {
		await ports.decrementReplies(snapshot.replyId);
	}
	ports.publishDeleted?.(snapshot, now);
	if (snapshot.authorHost === null && !snapshot.localOnly) {
		// 本家は deleted stream の後、ローカルの純粋 Renote の AP 準備だけで元投稿を読む。
		const deliverySnapshot = isPureRenote(snapshot.note)
			? { ...snapshot, renote: await ports.readRenote(snapshot.note.renoteId!) }
			: snapshot;
		const activity = ports.renderActivity(deliverySnapshot, now);
		ports.start({ kind: 'delivery', snapshot: deliverySnapshot, activity });
	}
	ports.start({ kind: 'charts', snapshot });
	if (snapshot.authorHost !== null) {
		ports.start({ kind: 'instanceCounts', snapshot });
	}
	ports.start({ kind: 'search', snapshot });
	await ports.deleteNote(snapshot.id, snapshot.userId);
	if (snapshot.userId !== actorId) {
		ports.start({ kind: 'audit', snapshot, actorId, occurredAtMs: now });
	}
}

export function createDeleteNote(ports: NoteDeletionPorts) {
	return {
		async deleteNote(actor: NoteCreateActor | null, input: unknown, now: number): Promise<void> {
			const { actor: authorized, facts, noteId } = await readDeletionRequest(actor, input, now, ports);
			const snapshot = await ports.readNote(noteId);
			if (snapshot === null) {
				throw new NoteDeleteError('NO_SUCH_NOTE');
			}
			if (snapshot.userId !== authorized.userId && !facts.isModerator) {
				throw new NoteDeleteError('ACCESS_DENIED');
			}
			await removeNote(snapshot, authorized.userId, now, ports);
		},
	};
}
