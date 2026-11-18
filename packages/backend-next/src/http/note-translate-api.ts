/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createApiEndpoints } from './api-endpoint.js';
import { NoteTranslationError } from '../modules/note-translate/public.js';
import type { AccessCredential, AccessRequest } from '../modules/access/public.js';
import type { Logger } from '../platform/logger.js';

const errors = {
	UNAVAILABLE: { message: 'Translate of notes unavailable.', id: '50a70314-2d8a-431b-b433-efa5cc56444c' },
	NO_SUCH_NOTE: { message: 'No such note.', id: 'bea9b03f-36e0-49c5-a4db-627a029f8971' },
	CANNOT_TRANSLATE_INVISIBLE_NOTE: { message: 'Cannot translate invisible note.', id: 'ea29f2ca-c368-43b3-aaf1-5ac3e74bbe5d' },
};

export function createNoteTranslateApi(dependencies: {
	authenticate(token: string | null | undefined): Promise<{ credential: AccessCredential } | null>;
	translateNote(access: AccessRequest, input: unknown, now: number): Promise<unknown>;
	logger: Logger;
}) {
	return createApiEndpoints({ ...dependencies, endpoints: [{
		name: 'notes/translate', access: { requireCredential: true, kind: 'read:account' },
		handle: (access, input) => dependencies.translateNote(access, input, Date.now()),
		errors: error => error instanceof NoteTranslationError ? { ...errors[error.code], code: error.code } : undefined,
	}] });
}
