/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { isVisibleForViewer } from '../note/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';

export type PersonalStateOperation = 'favorites/create' | 'favorites/delete' | 'thread-muting/create' | 'thread-muting/delete';
export interface PersonalStateNote {
	id: string;
	threadId: string | null;
	userId: string;
	userHost: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	visibleUserIds: string[];
	replyUserId: string | null;
	mentions: string[];
}
export interface NotePersonalStatePorts {
	readActor(id: string, now: number): Promise<AccessFacts & { movedToUri: string | null; rateLimitFactor: number }>;
	readNote(id: string): Promise<PersonalStateNote | null>;
	isFollowing(userId: string, authorId: string): Promise<boolean>;
	hasFavorite(userId: string, noteId: string): Promise<boolean>;
	readFavorite(userId: string, noteId: string): Promise<{ id: string } | null>;
	hasThreadMute(userId: string, threadId: string): Promise<boolean>;
	insertFavorite(row: { id: string; userId: string; noteId: string }): Promise<void>;
	deleteFavorite(id: string): Promise<void>;
	insertThreadMute(row: { id: string; userId: string; threadId: string }): Promise<void>;
	deleteThreadMute(userId: string, threadId: string): Promise<void>;
	limit(operation: PersonalStateOperation, userId: string, factor: number): Promise<void>;
	startAchievement(userId: string): void;
	newId(): string;
}

export class NotePersonalStateError extends Error {
	constructor(readonly code: string, readonly id: string, message: string, readonly info?: object) {
		super(message);
	}
}
const missingIds: Record<PersonalStateOperation, string> = {
	'favorites/create': '6dd26674-e060-4816-909a-45ba3f4da458',
	'favorites/delete': '80848a2c-398f-4343-baa9-df1d57696c56',
	'thread-muting/create': '5ff67ada-ed3b-2e71-8e87-a1a421e177d2',
	'thread-muting/delete': 'bddd57ac-ceb3-b29d-4334-86ea5fae481a',
};
const input = compileInput<{ noteId: string }>({ type: 'object', properties: { noteId: { type: 'string', format: 'misskey:id' } }, required: ['noteId'] });

export function createNotePersonalState(ports: NotePersonalStatePorts) {
	return {
		async execute(operation: PersonalStateOperation, access: AccessRequest, raw: unknown, now: number): Promise<void> {
			const actor = requireCredential(access.credential);
			const facts = await ports.readActor(actor.userId, now);
			if (operation.endsWith('/create')) {
				await ports.limit(operation, actor.userId, facts.rateLimitFactor);
			}
			access.authorize(facts);
			if (operation === 'favorites/create' && facts.movedToUri) {
				throw new NotePersonalStateError('YOUR_ACCOUNT_MOVED', '56f20ec9-fd06-4fa5-841b-edd6d7d4fa31', 'You have moved your account.');
			}
			const { noteId } = input(raw);
			const note = await ports.readNote(noteId);
			if (note === null || (operation === 'favorites/create' && !isVisibleForViewer(note, { id: actor.userId, host: null }, note.visibility === 'followers' && await ports.isFollowing(actor.userId, note.userId)))) {
				throw new NotePersonalStateError('NO_SUCH_NOTE', missingIds[operation], 'No such note.');
			}
			if (operation === 'favorites/create') {
				if (await ports.hasFavorite(actor.userId, note.id)) {
					throw new NotePersonalStateError('ALREADY_FAVORITED', 'a402c12b-34dd-41d2-97d8-4d2ffd96a1a6', 'The note has already been marked as a favorite.');
				}
				await ports.insertFavorite({ id: ports.newId(), noteId: note.id, userId: actor.userId });
				if (note.userHost === null && note.userId !== actor.userId) {
					ports.startAchievement(note.userId);
				}
			} else if (operation === 'favorites/delete') {
				const favorite = await ports.readFavorite(actor.userId, note.id);
				if (favorite === null) {
					throw new NotePersonalStateError('NOT_FAVORITED', 'b625fc69-635e-45e9-86f4-dbefbef35af5', 'You have not marked that note a favorite.');
				}
				await ports.deleteFavorite(favorite.id);
			} else {
				const threadId = note.threadId ?? note.id;
				if (operation === 'thread-muting/create') {
					if (await ports.hasThreadMute(actor.userId, threadId)) {
						throw new NotePersonalStateError('ALREADY_MUTING', 'c146e22d-1141-4b31-b28d-176371014d18', 'You are already muting that thread.');
					}
					await ports.insertThreadMute({ id: ports.newId(), userId: actor.userId, threadId });
				} else {
					await ports.deleteThreadMute(actor.userId, threadId);
				}
			}
		},
	};
}
