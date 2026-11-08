/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { AccessDenied, AuthenticationFailed, createAccessRequest, requiresCredential } from '../modules/access/public.js';
import { apiErrorResponse, AUTHENTICATION_FAILED, commonApiError, INTERNAL_ERROR } from './api-error.js';
import { readApiRequest, registerApiRoute } from './api-request.js';
import type { AccessCredential, AccessRequest, AccessRequirement } from '../modules/access/public.js';
import type { ApiErrorBody } from './api-error.js';
import type { Logger } from '../platform/logger.js';

export interface ApiEndpoint {
	/** `/api/`以降のendpoint名。 */
	readonly name: string;
	/** 本家endpoint metaの認可要件。 */
	readonly access: AccessRequirement;
	/**
	 * `access.authorize`を事実の取得後に必ず呼ぶ。成功しても呼ばれていなければ内部エラーにする。
	 * `undefined`・`null`は204、それ以外はJSONとして返す。
	 */
	handle(access: AccessRequest, input: unknown): Promise<unknown>;
	/** 本家endpoint metaの`errors`。共通エラーより先に変換する。 */
	errors?(error: unknown): ApiErrorBody | undefined;
}

export interface ApiEndpointsOptions {
	endpoints: readonly ApiEndpoint[];
	authenticate(token: string | null | undefined): Promise<{ credential: AccessCredential } | null>;
	logger: Logger;
}

export function createApiEndpoints(options: ApiEndpointsOptions): Hono {
	const app = new Hono();
	for (const endpoint of options.endpoints) {
		registerApiRoute(app, `/api/${endpoint.name}`, async context => {
			const request = await readApiRequest(context);
			if (request instanceof Response) {
				return request;
			}

			let credential: AccessCredential | null;
			try {
				credential = (await options.authenticate(request.token))?.credential ?? null;
			} catch (error) {
				if (error instanceof AuthenticationFailed) {
					return apiErrorResponse(AUTHENTICATION_FAILED);
				}
				// 本家の認証段階の失敗は、内部情報を付けないINTERNAL_ERRORになる。
				options.logger.error('api.authentication-failed', { endpoint: endpoint.name, error });
				return apiErrorResponse(INTERNAL_ERROR);
			}

			try {
				// 資格の有無だけは事実を読まずに判定できるため、UseCaseへ入る前に拒否する。
				if (credential === null && requiresCredential(endpoint.access)) {
					throw new AccessDenied('CREDENTIAL_REQUIRED');
				}

				const access = createAccessRequest(endpoint.access, credential);
				const result = await endpoint.handle(access, request.input);
				if (!access.authorized) {
					throw new Error(`Endpoint ${endpoint.name} completed without authorization`);
				}
				return result == null ? context.body(null, 204) : context.json(result);
			} catch (error) {
				const known = endpoint.errors?.(error) ?? commonApiError(error);
				if (known) {
					return apiErrorResponse(known);
				}
				const errorId = randomUUID();
				options.logger.error('api.failed', { endpoint: endpoint.name, errorId, error });
				return apiErrorResponse({ ...INTERNAL_ERROR, info: { e: {
					message: error instanceof Error ? error.message : String(error),
					code: error instanceof Error ? error.name : 'Error',
					id: errorId,
				} } });
			}
		});
	}
	return app;
}
