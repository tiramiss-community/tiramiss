/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { NoteCreateError } from './create-contract.js';
import { parseTextNoteInput } from './create-input.js';
import type { NewTextNote, NoteCreateActor, NoteCreateAuthor } from './create-contract.js';

export function createCreateNote(dependencies: {
	readAuthor(id: string, now: number): Promise<NoteCreateAuthor | null>;
	insert(note: NewTextNote): Promise<void>;
	afterSaved(note: NewTextNote): void;
	limit(userId: string, factor: number): Promise<void>;
	newId(now: number): string;
	matchesWords(text: string, words: string[]): boolean;
}) {
	return { async createNote(actor: NoteCreateActor | null, input: unknown, now: number): Promise<string> {
		if (actor === null) {
			throw new NoteCreateError('CREDENTIAL_REQUIRED');
		}
		const author = await dependencies.readAuthor(actor.userId, now);
		if (author === null) {
			throw new NoteCreateError('AUTHENTICATION_FAILED');
		}
		if (author.rateLimitFactor > 0) {
			await dependencies.limit(actor.userId, author.rateLimitFactor);
		}
		if (author.isSuspended) {
			throw new NoteCreateError('YOUR_ACCOUNT_SUSPENDED');
		}
		if (author.movedToUri) {
			throw new NoteCreateError('YOUR_ACCOUNT_MOVED');
		}
		if (!actor.canWriteNote) {
			throw new NoteCreateError('PERMISSION_DENIED');
		}

		const data = parseTextNoteInput(input);
		const visibility = data.visibility === 'public' &&
			(dependencies.matchesWords(data.cw ?? data.text, author.sensitiveWords) || !author.canPublicNote)
			? 'home' : data.visibility;
		if (dependencies.matchesWords(`${data.cw ?? ''}${data.text}\n\n`, author.prohibitedWords)) {
			throw new NoteCreateError('CONTAINS_PROHIBITED_WORDS');
		}
		const note: NewTextNote = {
			id: dependencies.newId(now), userId: actor.userId,
			text: data.text.trim(), cw: data.cw ?? null, visibility,
			localOnly: data.localOnly, reactionAcceptance: data.reactionAcceptance,
		};
		await dependencies.insert(note);
		dependencies.afterSaved(note);
		return note.id;
	} };
}
