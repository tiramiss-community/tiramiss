/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createRequestEvaluation, type RoleActor, type RoleEvaluation, type RoleShowData } from '../modules/role/public.js';
import { roleResponse } from './role-response.js';
import { apiErrorResponse } from './api-error.js';
import type { Logger } from '../platform/logger.js';

export function createRoleApi(dependencies: {
	authenticate(token: string | null | undefined): Promise<RoleActor>;
	showRole(actor: RoleActor, input: unknown, evaluation: RoleEvaluation): Promise<RoleShowData>;
	updateRole(actor: RoleActor, input: unknown, evaluation: RoleEvaluation): Promise<void>;
	logger: Logger;
}) {
	const app = new Hono();
	for (const operation of ['show', 'update'] as const) {
		app.all(`/api/admin/roles/${operation}`, bodyLimit({
			maxSize: 1024 * 1024,
			// 未読の本文を残した接続を次のリクエストへ再利用しない。
			onError: context => context.body(null, 413, { Connection: 'close' }),
		}), async context => {
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

			const authorization = context.req.header('authorization');
			const bodyToken = input !== null && typeof input === 'object' ? (input as Record<string, unknown>).i : undefined;
			const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : bodyToken;
			if (token != null && typeof token !== 'string') {
				return context.body(null, 400);
			}

			const evaluation = createRequestEvaluation(Date.now);
			try {
				const actor = await dependencies.authenticate(token);
				if (operation === 'show') {
					return context.json(roleResponse(await dependencies.showRole(actor, input, evaluation)));
				}

				await dependencies.updateRole(actor, input, evaluation);
				return context.body(null, 204);
			} catch (error) {
				const response = apiErrorResponse(error, operation);
				if (response.status === 500) {
					dependencies.logger.error('role-api.failed', { operation, error });
				}
				return response;
			} finally {
				evaluation.close();
			}
		});
	}
	return app;
}
