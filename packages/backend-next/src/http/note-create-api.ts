/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { NoteCreateError } from '../modules/note/public.js';
import { apiErrorResponse } from './api-error.js';
import type { JsonObject, NoteCreateActor, NoteCreateErrorCode } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

const errors: Record<NoteCreateErrorCode, { message: string; id: string; kind: string; status: 400 | 401 | 403 | 429 | 501 }> = {
	CREDENTIAL_REQUIRED: { message: 'Credential required.', id: '1384574d-a912-4b81-8601-c7b1c4085df1', kind: 'client', status: 401 },
	AUTHENTICATION_FAILED: { message: 'Authentication failed. Please ensure your token is correct.', id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14', kind: 'client', status: 401 },
	YOUR_ACCOUNT_SUSPENDED: { message: 'Your account has been suspended.', id: 'a8c724b3-6e9c-4b46-b1a8-bc3ed6258370', kind: 'permission', status: 403 },
	YOUR_ACCOUNT_MOVED: { message: 'You have moved your account.', id: '56f20ec9-fd06-4fa5-841b-edd6d7d4fa31', kind: 'permission', status: 403 },
	PERMISSION_DENIED: { message: 'Your app does not have the necessary permissions to use this endpoint.', id: '1370e5b7-d4eb-4566-bb1d-7748ee6a1838', kind: 'permission', status: 403 },
	INVALID_PARAM: { message: 'Invalid param.', id: '3d81ceae-475f-4600-b2a8-2bc116157532', kind: 'client', status: 400 },
	CONTAINS_PROHIBITED_WORDS: { message: 'Cannot post because it contains prohibited words.', id: 'aa6e01d3-a85c-669d-758a-76aab43af334', kind: 'client', status: 400 },
	RATE_LIMIT_EXCEEDED: { message: 'Rate limit exceeded. Please try again later.', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef', kind: 'client', status: 429 },
	NOT_IMPLEMENTED: { message: 'This note input is not implemented yet.', id: '9b77c156-89e5-44f0-8ab9-4bc5f9e2e3ad', kind: 'server', status: 501 },
};

export function createNoteCreateApi(dependencies: {
	authenticate(token: string): Promise<NoteCreateActor>;
	createNote(actor: NoteCreateActor | null, input: unknown, now: number): Promise<string>;
	readCreatedNote(id: string, viewerId: string, now: number): Promise<JsonObject>;
	logger: Logger;
}) {
	const app = new Hono();
	app.use('/api/notes/create', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'POST'] }));
	app.use('/api/notes/create', async (context, next) => {
		context.header('Cache-Control', 'private, max-age=0, must-revalidate');
		await next();
	});
	app.all('/api/notes/create', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.body(null, 413, { Connection: 'close' }) }), async context => {
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
			const actor = token == null ? null : await dependencies.authenticate(token);
			const now = Date.now();
			const id = await dependencies.createNote(actor, input, now);
			return context.json({ createdNote: await dependencies.readCreatedNote(id, actor!.userId, now) });
		} catch (error) {
			if (error instanceof NoteCreateError) {
				const { status, ...body } = errors[error.code];
				if (error.code === 'CREDENTIAL_REQUIRED') {
					context.header('WWW-Authenticate', 'Bearer realm="Misskey"');
				} else if (error.code === 'AUTHENTICATION_FAILED' || error.code === 'PERMISSION_DENIED' || (body.kind === 'client' && status !== 429)) {
					const reason = error.code === 'AUTHENTICATION_FAILED' ? 'invalid_token' : error.code === 'PERMISSION_DENIED' ? 'insufficient_scope' : 'invalid_request';
					context.header('WWW-Authenticate', `Bearer realm="Misskey", error="${reason}", error_description="${body.message}"`);
				} else if (status === 429 && error.info && 'resetMs' in error.info && typeof error.info.resetMs === 'number') {
					context.header('Retry-After', Math.max(0, Math.ceil((error.info.resetMs - Date.now()) / 1000)).toString());
				}
				return context.json({ error: { ...body, code: error.code, ...(error.info ? { info: error.info } : {}) } }, status);
			}
			const response = apiErrorResponse(error, 'show');
			if (response.status === 500) {
				dependencies.logger.error('note-create.failed', { error });
			}
			return response;
		}
	});
	return app;
}
