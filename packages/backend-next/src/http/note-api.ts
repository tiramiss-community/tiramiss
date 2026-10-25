/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { NoteReadError } from '../modules/note/public.js';
import { ApiInputInvalid } from './input-error.js';
import { apiErrorResponse } from './api-error.js';
import type { JsonObject } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

const ajv = new Ajv();
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile({ type: 'object', properties: { noteId: { type: 'string', format: 'misskey:id' } }, required: ['noteId'] });
const errors = {
	NO_SUCH_NOTE: { message: 'No such note.', id: '24fcbfc6-2e37-42b6-8388-c29b3861a08d' },
	CONTENT_RESTRICTED_BY_USER: { message: 'Content restricted by user. Please sign in to view.', id: 'fbcc002d-37d9-4944-a6b0-d9e29f2d33ab' },
	CONTENT_RESTRICTED_BY_SERVER: { message: 'Content restricted by server settings. Please sign in to view.', id: '145f88d2-b03d-4087-8143-a78928883c4b' },
};

export function createNoteApi(dependencies: {
	authenticate(token: string): Promise<{ userId: string }>;
	showNote(id: string, viewerId: string | null, now: number): Promise<JsonObject>;
	logger: Logger;
}) {
	const app = new Hono();
	app.use('/api/notes/show', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'POST'] }));
	app.use('/api/notes/show', async (context, next) => {
		context.header('Cache-Control', 'private, max-age=0, must-revalidate');
		await next();
	});
	app.all('/api/notes/show', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.body(null, 413, { Connection: 'close' }) }), async context => {
		if (context.req.method === 'GET') {
			return context.body(null, 405);
		}
		let input: unknown;
		try {
			const text = await context.req.text();
			input = text === '' ? undefined : JSON.parse(text);
		} catch {
			return context.body(null, 400);
		}
		const bodyToken = input !== null && typeof input === 'object' ? (input as Record<string, unknown>).i : undefined;
		const authorization = context.req.header('authorization');
		const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : bodyToken;
		if (token != null && typeof token !== 'string') {
			return context.body(null, 400);
		}
		try {
			const viewerId = token == null ? null : (await dependencies.authenticate(token)).userId;
			if (!validate(input)) {
				const error = validate.errors![0];
				throw new ApiInputInvalid(error.schemaPath, error.message!);
			}
			return context.json(await dependencies.showNote((input as { noteId: string }).noteId, viewerId, Date.now()));
		} catch (error) {
			if (error instanceof NoteReadError) {
				context.header('WWW-Authenticate', `Bearer realm="Misskey", error="invalid_request", error_description="${errors[error.code].message}"`);
				return context.json({ error: { ...errors[error.code], code: error.code, kind: 'client' } }, 400);
			}
			const response = apiErrorResponse(error, 'show');
			if (response.status === 500) {
				dependencies.logger.error('note-show.failed', { error });
			}
			return response;
		}
	});
	return app;
}
