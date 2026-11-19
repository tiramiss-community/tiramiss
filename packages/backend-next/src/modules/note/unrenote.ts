/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { DeletedNoteSnapshot } from './delete-note.js';
import { NoteDeleteError, readDeletionRequest } from './deletion-request.js';
import type { NoteCreateActor } from './create-contract.js';

export function createUnrenote(ports: {
	readActor(userId: string, now: number): Promise<{ isSuspended: boolean; rateLimitFactor: number } | null>;
	limit(userId: string, factor: number): Promise<void>;
	readTarget(noteId: string): Promise<boolean>;
	readOwnRenotes(userId: string, noteId: string): Promise<DeletedNoteSnapshot[]>;
	startRemoval(note: DeletedNoteSnapshot, userId: string, now: number): void;
}) {
	return {
		async unrenote(actor: NoteCreateActor | null, input: unknown, now: number): Promise<void> {
			const { actor: authorized, noteId } = await readDeletionRequest(actor, input, now, ports);
			if (!await ports.readTarget(noteId)) {
				throw new NoteDeleteError('NO_SUCH_NOTE');
			}
			const renotes = await ports.readOwnRenotes(authorized.userId, noteId);
			for (const renote of renotes) {
				ports.startRemoval(renote, authorized.userId, now);
			}
		},
	};
}
