/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import type { NoteCreateActor } from './create-contract.js';

export type NoteDeleteErrorCode = 'CREDENTIAL_REQUIRED' | 'AUTHENTICATION_FAILED' | 'YOUR_ACCOUNT_SUSPENDED' | 'PERMISSION_DENIED' | 'INVALID_PARAM' | 'RATE_LIMIT_EXCEEDED' | 'NO_SUCH_NOTE' | 'ACCESS_DENIED';
export class NoteDeleteError extends Error {
	constructor(public readonly code: NoteDeleteErrorCode, public readonly info?: object) {
		super(code);
	}
}

const ajv = new Ajv();
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile({ type: 'object', properties: { noteId: { type: 'string', format: 'misskey:id' } }, required: ['noteId'] });

export async function readDeletionRequest<Facts extends { isSuspended: boolean; rateLimitFactor: number }>(
	actor: NoteCreateActor | null, input: unknown, now: number,
	ports: { readActor(userId: string, now: number): Promise<Facts | null>; limit(userId: string, factor: number): Promise<void> },
) {
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
	return { actor, facts, noteId: (input as { noteId: string }).noteId };
}
