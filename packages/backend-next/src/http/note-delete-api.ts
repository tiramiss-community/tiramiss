/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { NoteDeleteError } from '../modules/note/public.js';
import { apiErrorResponse, commonApiError, INTERNAL_ERROR } from './api-error.js';
import { readApiRequest, registerApiRoute } from './api-request.js';
import type { NoteCreateActor, NoteDeleteErrorCode } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

const errors: Record<NoteDeleteErrorCode, { message: string; id: string; kind: 'client' | 'permission'; status: 400 | 401 | 403 | 429 }> = {
	CREDENTIAL_REQUIRED: { message: 'Credential required.', id: '1384574d-a912-4b81-8601-c7b1c4085df1', kind: 'client', status: 401 },
	AUTHENTICATION_FAILED: { message: 'Authentication failed. Please ensure your token is correct.', id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14', kind: 'client', status: 401 },
	YOUR_ACCOUNT_SUSPENDED: { message: 'Your account has been suspended.', id: 'a8c724b3-6e9c-4b46-b1a8-bc3ed6258370', kind: 'permission', status: 403 },
	PERMISSION_DENIED: { message: 'Your app does not have the necessary permissions to use this endpoint.', id: '1370e5b7-d4eb-4566-bb1d-7748ee6a1838', kind: 'permission', status: 403 },
	INVALID_PARAM: { message: 'Invalid param.', id: '3d81ceae-475f-4600-b2a8-2bc116157532', kind: 'client', status: 400 },
	RATE_LIMIT_EXCEEDED: { message: 'Rate limit exceeded. Please try again later.', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef', kind: 'client', status: 429 },
	NO_SUCH_NOTE: { message: 'No such note.', id: '490be23f-8c1f-4796-819f-94cb4f9d1630', kind: 'client', status: 400 },
	ACCESS_DENIED: { message: 'Access denied.', id: 'fe8d7103-0ea8-4ec3-814d-f8b401dc69e9', kind: 'client', status: 400 },
};

export function createNoteDeleteApi(dependencies: {
	authenticate(token: string | null | undefined): Promise<{ credential: NoteCreateActor } | null>;
	deleteNote(actor: NoteCreateActor | null, input: unknown, now: number): Promise<void>;
	logger: Logger;
}) {
	const app = new Hono();
	registerApiRoute(app, '/api/notes/delete', async context => {
		const request = await readApiRequest(context);
		if (request instanceof Response) {
			return request;
		}
		try {
			const actor = (await dependencies.authenticate(request.token))?.credential ?? null;
			const now = Date.now();
			await dependencies.deleteNote(actor, request.input, now);
			return context.body(null, 204);
		} catch (error) {
			if (error instanceof NoteDeleteError) {
				return apiErrorResponse({ ...errors[error.code], code: error.code, info: error.info });
			}
			const known = commonApiError(error);
			if (known) {
				return apiErrorResponse(known);
			}
			dependencies.logger.error('note-delete.failed', { error });
			return apiErrorResponse(INTERNAL_ERROR);
		}
	});
	return app;
}
