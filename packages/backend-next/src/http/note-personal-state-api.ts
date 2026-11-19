/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { NotePersonalStateError } from '../modules/note-personal-state/public.js';
import type { createNotePersonalState } from '../modules/note-personal-state/public.js';
import type { ApiEndpoint } from './api-endpoint.js';

export function createNotePersonalStateEndpoints(application: ReturnType<typeof createNotePersonalState>): ApiEndpoint[] {
	return (['favorites/create', 'favorites/delete', 'thread-muting/create', 'thread-muting/delete'] as const).map(operation => ({
		name: `notes/${operation}`,
		access: { requireCredential: true, kind: operation.startsWith('favorites/') ? 'write:favorites' : 'write:account' },
		handle: (access, input) => application.execute(operation, access, input, Date.now()),
		errors: error => error instanceof NotePersonalStateError ? {
			message: error.message, code: error.code, id: error.id,
			...(error.info ? { info: error.info } : {}),
			...(error.code === 'RATE_LIMIT_EXCEEDED' ? { status: 429 } : {}),
			...(error.code === 'YOUR_ACCOUNT_MOVED' ? { kind: 'permission' as const } : {}),
		} : undefined,
	}));
}
