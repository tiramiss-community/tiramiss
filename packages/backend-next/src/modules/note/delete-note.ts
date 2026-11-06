/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import type { NoteCreateActor } from './create-contract.js';
import type { NoteActivityNote } from '../federation/public.js';

export type NoteDeleteErrorCode = 'CREDENTIAL_REQUIRED' | 'AUTHENTICATION_FAILED' | 'YOUR_ACCOUNT_SUSPENDED' | 'PERMISSION_DENIED' | 'INVALID_PARAM' | 'RATE_LIMIT_EXCEEDED' | 'NO_SUCH_NOTE' | 'ACCESS_DENIED';
export class NoteDeleteError extends Error {
	constructor(public readonly code: NoteDeleteErrorCode, public readonly info?: object) {
		super(code);
	}
}
export interface DeletedNoteSnapshot {
	id: string;
	userId: string;
	authorHost: string | null;
	authorUsername: string;
	localOnly: boolean;
	replyId: string | null;
	renoteUserId: string | null;
	note: NoteActivityNote;
	renote: { id: string; uri: string | null } | null;
	auditNote: Record<string, unknown>;
}
export type NoteDeleteWork =
 | { kind: 'delivery'; snapshot: DeletedNoteSnapshot; activity: Record<string, unknown> }
 | { kind: 'stream'; snapshot: DeletedNoteSnapshot; occurredAtMs: number }
 | { kind: 'audit'; snapshot: DeletedNoteSnapshot; actorId: string; occurredAtMs: number };

const ajv = new Ajv();
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile({ type: 'object', properties: { noteId: { type: 'string', format: 'misskey:id' } }, required: ['noteId'] });

export function createDeleteNote(ports: {
	readActor(userId: string, now: number): Promise<{ isSuspended: boolean; rateLimitFactor: number; isModerator: boolean } | null>;
	limit(userId: string, factor: number): Promise<void>;
	readNote(id: string): Promise<DeletedNoteSnapshot | null>;
	decrementReplies(noteId: string): Promise<void>;
	publishDeleted?(snapshot: DeletedNoteSnapshot, deletedAt: number): void;
	renderActivity(snapshot: DeletedNoteSnapshot, now: number): Record<string, unknown>;
	start(work: NoteDeleteWork): void;
	deleteNote(noteId: string, authorId: string): Promise<void>;
}) {
	return {
		async deleteNote(actor: NoteCreateActor | null, input: unknown, now: number): Promise<void> {
			if (actor === null) {
				throw new NoteDeleteError('CREDENTIAL_REQUIRED');
			}
			const facts = await ports.readActor(actor.userId, now);
			if (facts === null) {
				throw new NoteDeleteError('AUTHENTICATION_FAILED');
			}
			if (facts.rateLimitFactor > 0) {
				await ports.limit(actor.userId, facts.rateLimitFactor);
			}
			if (facts.isSuspended) {
				throw new NoteDeleteError('YOUR_ACCOUNT_SUSPENDED');
			}
			if (!actor.canWriteNote) {
				throw new NoteDeleteError('PERMISSION_DENIED');
			}
			if (!validate(input)) {
				const error = validate.errors![0];
				throw new NoteDeleteError('INVALID_PARAM', { param: error.schemaPath, reason: error.message! });
			}
			const snapshot = await ports.readNote((input as { noteId: string }).noteId);
			if (snapshot === null) {
				throw new NoteDeleteError('NO_SUCH_NOTE');
			}
			if (snapshot.userId !== actor.userId && !facts.isModerator) {
				throw new NoteDeleteError('ACCESS_DENIED');
			}
			// 本家はこの減算を独立した文として先に確定する。後の DELETE 失敗で巻き戻したことにはしない。
			if (snapshot.replyId !== null) {
				await ports.decrementReplies(snapshot.replyId);
			}
			ports.publishDeleted?.(snapshot, now);
			if (snapshot.authorHost === null && !snapshot.localOnly) {
				const activity = ports.renderActivity(snapshot, now);
				ports.start({ kind: 'delivery', snapshot, activity });
			}
			await ports.deleteNote(snapshot.id, snapshot.userId);
			if (snapshot.userId !== actor.userId) {
				ports.start({ kind: 'audit', snapshot, actorId: actor.userId, occurredAtMs: now });
			}
		},
	};
}
