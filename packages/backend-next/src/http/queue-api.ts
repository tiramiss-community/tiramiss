/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { QUEUE_OPERATIONS, QueueInputInvalid } from '../modules/queue/public.js';
import { ApiInputInvalid } from './input-error.js';
import { apiErrorResponse } from './api-error.js';
import type { QueueActor, createQueueAdmin } from '../modules/queue/public.js';
import type { Logger } from '../platform/logger.js';

export function createQueueApi(options: { authenticate(token: string | null | undefined): Promise<QueueActor>; admin: ReturnType<typeof createQueueAdmin>; logger: Logger }) {
	const app = new Hono();
	app.use('/api/admin/queue/*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'POST'] }));
	app.use('/api/admin/queue/*', async (context, next) => {
		context.header('Cache-Control', 'private, max-age=0, must-revalidate'); await next();
	});
	for (const operation of QUEUE_OPERATIONS) {
		app.all(`/api/admin/queue/${operation}`, bodyLimit({ maxSize: 1024 * 1024, onError: c => c.body(null, 413, { Connection: 'close' }) }), async context => {
			if (context.req.method === 'GET') {
				return context.body(null, 405);
			}
			let input: unknown;
			try {
				const text = await context.req.text(); input = text === '' ? undefined : JSON.parse(text);
			} catch {
				return context.body(null, 400);
			}
			const authorization = context.req.header('authorization');
			const bodyToken = input !== null && typeof input === 'object' ? (input as Record<string, unknown>).i : undefined;
			const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : bodyToken;
			if (token != null && typeof token !== 'string') {
				return context.body(null, 400);
			}
			try {
				const actor = await options.authenticate(token);
				const result = await options.admin.execute(actor, operation, input, Date.now());
				return result === undefined ? context.body(null, 204) : context.json(result);
			} catch (error) {
				const response = apiErrorResponse(error instanceof QueueInputInvalid ? new ApiInputInvalid(error.param, error.reason) : error, 'show');
				if (response.status !== 500) {
					return response;
				}
				options.logger.error('queue-api.failed', { operation, error });
				const body = await response.json() as { error: Record<string, unknown> };
				body.error.info = { e: { message: error instanceof Error ? error.message : String(error), code: error instanceof Error ? error.name : 'Error', id: randomUUID() } };
				return context.json(body, 500);
			}
		});
	}
	return app;
}
