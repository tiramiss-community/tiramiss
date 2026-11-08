/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { compileInput } from '../modules/access/public.js';
import { NoteReadError } from '../modules/note/public.js';
import { apiErrorResponse, commonApiError, INTERNAL_ERROR } from './api-error.js';
import { readApiRequest, registerApiRoute } from './api-request.js';
import type { AccessCredential } from '../modules/access/public.js';
import type { JsonObject } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

const readInput = compileInput<{ noteId: string }>({ type: 'object', properties: { noteId: { type: 'string', format: 'misskey:id' } }, required: ['noteId'] });
const errors = {
	NO_SUCH_NOTE: { message: 'No such note.', id: '24fcbfc6-2e37-42b6-8388-c29b3861a08d' },
	CONTENT_RESTRICTED_BY_USER: { message: 'Content restricted by user. Please sign in to view.', id: 'fbcc002d-37d9-4944-a6b0-d9e29f2d33ab' },
	CONTENT_RESTRICTED_BY_SERVER: { message: 'Content restricted by server settings. Please sign in to view.', id: '145f88d2-b03d-4087-8143-a78928883c4b' },
};

export function createNoteApi(dependencies: {
	authenticate(token: string | null | undefined): Promise<{ credential: AccessCredential } | null>;
	showNote(id: string, viewerId: string | null, now: number): Promise<JsonObject>;
	logger: Logger;
}) {
	const app = new Hono();
	registerApiRoute(app, '/api/notes/show', async context => {
		const request = await readApiRequest(context);
		if (request instanceof Response) {
			return request;
		}
		try {
			const viewerId = (await dependencies.authenticate(request.token))?.credential.userId ?? null;
			const { noteId } = readInput(request.input);
			return context.json(await dependencies.showNote(noteId, viewerId, Date.now()));
		} catch (error) {
			if (error instanceof NoteReadError) {
				return apiErrorResponse({ ...errors[error.code], code: error.code });
			}
			const known = commonApiError(error);
			if (known) {
				return apiErrorResponse(known);
			}
			dependencies.logger.error('note-show.failed', { error });
			return apiErrorResponse(INTERNAL_ERROR);
		}
	});
	return app;
}
