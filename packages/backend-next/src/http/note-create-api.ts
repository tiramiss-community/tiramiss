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
	NO_SUCH_FILE: { message: 'Some files are not found.', id: 'b6992544-63e7-67f0-fa7f-32444b1b5306', kind: 'client', status: 400 },
	NO_SUCH_RENOTE_TARGET: { message: 'No such renote target.', id: 'b5c90186-4ab0-49c8-9bba-a1f76c282ba4', kind: 'client', status: 400 },
	CANNOT_RENOTE_TO_A_PURE_RENOTE: { message: 'You can not Renote a pure Renote.', id: 'fd4cc33e-2a37-48dd-99cc-9b806eb2031a', kind: 'client', status: 400 },
	YOU_HAVE_BEEN_BLOCKED: { message: 'You have been blocked by this user.', id: 'b390d7e1-8a5e-46ed-b625-06271cafd3d3', kind: 'client', status: 400 },
	CANNOT_RENOTE_DUE_TO_VISIBILITY: { message: 'You can not Renote due to target visibility.', id: 'be9529e9-fe72-4de0-ae43-0b363c4938af', kind: 'client', status: 400 },
	NO_SUCH_CHANNEL: { message: 'No such channel.', id: 'b1653923-5453-4edc-b786-7c4f39bb0bbb', kind: 'client', status: 400 },
	CANNOT_RENOTE_OUTSIDE_OF_CHANNEL: { message: 'Cannot renote outside of channel.', id: '33510210-8452-094c-6227-4a6c05d99f00', kind: 'client', status: 400 },
	NO_SUCH_REPLY_TARGET: { message: 'No such reply target.', id: '749ee0f6-d3da-459a-bf02-282e2da4292c', kind: 'client', status: 400 },
	CANNOT_REPLY_TO_A_PURE_RENOTE: { message: 'You can not reply to a pure Renote.', id: '3ac74a84-8fd5-4bb0-870f-01804f82ce15', kind: 'client', status: 400 },
	CANNOT_REPLY_TO_AN_INVISIBLE_NOTE: { message: 'You cannot reply to an invisible Note.', id: 'b98980fa-3780-406c-a935-b6d0eeee10d1', kind: 'client', status: 400 },
	CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY: { message: 'You cannot reply to a specified visibility note with extended visibility.', id: 'ed940410-535c-4d5e-bfa3-af798671e93c', kind: 'client', status: 400 },
	CANNOT_CREATE_ALREADY_EXPIRED_POLL: { message: 'Poll is already expired.', id: '04da457d-b083-4055-9082-955525eda5a5', kind: 'client', status: 400 },
	CONTAINS_TOO_MANY_MENTIONS: { message: 'Cannot post because it exceeds the allowed number of mentions.', id: '4de0363a-3046-481b-9b0f-feff3e211025', kind: 'client', status: 400 },
};

export function createNoteCreateApi(dependencies: {
	authenticate(token: string): Promise<NoteCreateActor>;
	createNote<T>(actor: NoteCreateActor | null, input: unknown, now: number, render: (noteId: string, viewerId: string) => Promise<T>): Promise<T>;
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
			const createdNote = await dependencies.createNote(actor, input, now, (id, viewerId) => dependencies.readCreatedNote(id, viewerId, now));
			return context.json({ createdNote });
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
