/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';

export interface PromoRow {
	noteId: string;
	userId: string;
	expiresAt: Date;
}

export interface PromoPorts {
	readActor(userId: string): Promise<AccessFacts>;
	readNote(noteId: string): Promise<{ id: string; userId: string } | null>;
	exists(noteId: string): Promise<boolean>;
	insert(row: PromoRow): Promise<void>;
}

export class PromoError extends Error {
	constructor(readonly code: 'NO_SUCH_NOTE' | 'ALREADY_PROMOTED') {
		super(code === 'NO_SUCH_NOTE' ? 'No such note.' : 'The note has already promoted.');
	}

	get id(): string {
		return this.code === 'NO_SUCH_NOTE' ? 'ee449fbe-af2a-453b-9cae-cf2fe7c895fc' : 'ae427aa2-7a41-484f-a18c-2c1104051604';
	}
}

const input = compileInput<{ noteId: string; expiresAt: number }>({
	type: 'object',
	properties: { noteId: { type: 'string', format: 'misskey:id' }, expiresAt: { type: 'integer' } },
	required: ['noteId', 'expiresAt'],
});

export function createPromo(ports: PromoPorts) {
	return {
		async create(access: AccessRequest, raw: unknown): Promise<void> {
			const actor = requireCredential(access.credential);
			access.authorize(await ports.readActor(actor.userId));
			const params = input(raw);
			const note = await ports.readNote(params.noteId);
			if (note === null) {
				throw new PromoError('NO_SUCH_NOTE');
			}
			if (await ports.exists(note.id)) {
				throw new PromoError('ALREADY_PROMOTED');
			}
			await ports.insert({ noteId: note.id, userId: note.userId, expiresAt: new Date(params.expiresAt) });
		},
	};
}
