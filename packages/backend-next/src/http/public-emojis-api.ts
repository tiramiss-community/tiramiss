/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { createApiEndpoints } from './api-endpoint.js';
import { compileInput } from '../modules/access/public.js';
import type { createPublicEmojis } from '../modules/emoji/public.js';
import type { ApiEndpoint, ApiEndpointsOptions } from './api-endpoint.js';

const listInput = compileInput({ type: 'object', properties: {}, required: [] });
const showInput = compileInput<{ name: string }>({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });

export function createPublicEmojiEndpoints(application: ReturnType<typeof createPublicEmojis>): ApiEndpoint[] {
	return [
		{ name: 'emojis', access: {}, allowGet: true, cacheSec: 3600, handle: async (_access, input) => {
			listInput(input);
			return application.list();
		} },
		{ name: 'emoji', access: {}, allowGet: true, cacheSec: 3600, handle: async (_access, input) => application.show(showInput(input).name) },
	];
}

export function createPublicEmojisApi(application: ReturnType<typeof createPublicEmojis>, options: Omit<ApiEndpointsOptions, 'endpoints'>) {
	const app = new Hono();
	for (const path of ['/api/emoji', '/api/emojis']) {
		app.use(path, async (context, next) => {
			await next();
			if (context.res.headers.get('Content-Type') === 'application/json') {
				context.header('Content-Type', 'application/json; charset=utf-8');
			}
		});
	}
	return app.route('/', createApiEndpoints({ ...options, endpoints: createPublicEmojiEndpoints(application) }));
}
