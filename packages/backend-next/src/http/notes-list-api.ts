/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { compileInput } from '../modules/access/public.js';
import { apiErrorResponse, commonApiError, INTERNAL_ERROR } from './api-error.js';
import { readApiRequest, registerApiRoute } from './api-request.js';
import type { NotesListInput } from '../modules/note/public.js';
import type { AccessCredential } from '../modules/access/public.js';
import type { JsonObject } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

const readInput = compileInput<NotesListInput>({
	type: 'object',
	properties: {
		local: { type: 'boolean', default: false },
		reply: { type: 'boolean' }, renote: { type: 'boolean' }, withFiles: { type: 'boolean' }, poll: { type: 'boolean' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' }, untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' }, untilDate: { type: 'integer' },
	},
	required: [],
});

export function createNotesListApi(dependencies: {
	authenticate(token: string | null | undefined): Promise<{ credential: AccessCredential } | null>;
	listNotes(input: NotesListInput, viewerId: string | null, now: number): Promise<JsonObject[]>;
	logger: Logger;
}) {
	const app = new Hono();
	registerApiRoute(app, '/api/notes', async context => {
		const request = await readApiRequest(context);
		if (request instanceof Response) {
			return request;
		}
		try {
			const viewerId = (await dependencies.authenticate(request.token))?.credential.userId ?? null;
			return context.json(await dependencies.listNotes(readInput(request.input), viewerId, Date.now()));
		} catch (error) {
			const known = commonApiError(error);
			if (known) {
				return apiErrorResponse(known);
			}
			dependencies.logger.error('notes-list.failed', { error });
			return apiErrorResponse(INTERNAL_ERROR);
		}
	});
	return app;
}
