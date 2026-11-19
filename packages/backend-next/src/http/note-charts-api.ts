/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { recordAuthenticatedApiIp } from './api-ip-log.js';
import { compileInput } from '../modules/access/public.js';
import { apiErrorResponse, commonApiError, INTERNAL_ERROR } from './api-error.js';
import { readApiRequest, registerApiRoute } from './api-request.js';
import type { createNoteCharts, ChartSeries } from '../modules/chart/public.js';
import type { ApiEndpointsOptions } from './api-endpoint.js';

interface Input { span: 'hour' | 'day'; limit: number; offset: number | null; userId?: string }
const properties = {
	span: { type: 'string', enum: ['day', 'hour'] },
	limit: { type: 'integer', minimum: 1, maximum: 500, default: 30 },
	offset: { type: 'integer', nullable: true, default: null },
};
const parseNotes = compileInput<Input>({ type: 'object', properties, required: ['span'] });
const parseUser = compileInput<Input>({ type: 'object', properties: { ...properties, userId: { type: 'string', format: 'misskey:id' } }, required: ['span', 'userId'] });

interface ChartRoute { path: string; series: ChartSeries; parse: (input: unknown) => Input }

function createChartsApi(charts: Pick<ReturnType<typeof createNoteCharts>, 'read'>, options: Omit<ApiEndpointsOptions, 'endpoints'>, routes: ChartRoute[]) {
	const app = new Hono();
	for (const route of routes) {
		registerApiRoute(app, route.path, async context => {
			const request = await readApiRequest(context, true);
			if (request instanceof Response) {
				return request;
			}
			try {
				const credential = await options.authenticate(request.token);
				recordAuthenticatedApiIp(context, credential?.credential.userId);
				if (context.req.method === 'GET' && request.input && typeof request.input === 'object') {
					const input = request.input as Record<string, unknown>;
					for (const key of ['limit', 'offset']) {
						if (typeof input[key] === 'string') {
							try {
								input[key] = JSON.parse(input[key]);
							} catch {
								return apiErrorResponse({ message: 'Invalid param.', code: 'INVALID_PARAM', id: '0b5f1631-7c1a-41a6-b399-cce335f34d85', info: { param: key, reason: 'cannot cast to integer' } });
							}
						}
					}
				}
				const input = route.parse(request.input);
				const result = await charts.read(route.series, input.span, input.limit, input.offset, route.series === 'perUserNotes' ? input.userId! : null);
				if (context.req.method === 'GET' && !request.token && credential === null) {
					context.header('Cache-Control', 'public, max-age=3600');
				}
				return context.json(result);
			} catch (error) {
				const known = commonApiError(error);
				if (known) {
					return apiErrorResponse(known);
				}
				options.logger.error('note-charts.failed', { error });
				return apiErrorResponse(INTERNAL_ERROR);
			}
		});
	}
	return app;
}

export function createNoteChartsApi(charts: Pick<ReturnType<typeof createNoteCharts>, 'read'>, options: Omit<ApiEndpointsOptions, 'endpoints'>) {
	return createChartsApi(charts, options, [
		{ path: '/api/charts/notes', series: 'notes', parse: parseNotes },
		{ path: '/api/charts/user/notes', series: 'perUserNotes', parse: parseUser },
	]);
}

export function createUsersChartsApi(charts: Pick<ReturnType<typeof createNoteCharts>, 'read'>, options: Omit<ApiEndpointsOptions, 'endpoints'>) {
	return createChartsApi(charts, options, [{ path: '/api/charts/users', series: 'users', parse: parseNotes }]);
}
