/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AccessDenied, AuthenticationFailed, InputInvalid } from '../modules/access/public.js';
import type { AccessDeniedReason } from '../modules/access/public.js';

/** 本家ApiErrorの公開項目。`kind`の既定値は本家と同じ`client`。 */
export interface ApiErrorBody {
	message: string;
	code: string;
	id: string;
	kind?: 'client' | 'permission' | 'server';
	status?: number;
	info?: object;
}

export const INTERNAL_ERROR: ApiErrorBody = {
	message: 'Internal error occurred. Please contact us if the error persists.', code: 'INTERNAL_ERROR',
	id: '5d37dbcb-891e-41ca-a3d6-e690c97775ac', kind: 'server', status: 500,
};

export const AUTHENTICATION_FAILED: ApiErrorBody = {
	message: 'Authentication failed. Please ensure your token is correct.', code: 'AUTHENTICATION_FAILED',
	id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14', kind: 'client', status: 401,
};

const accessDenied: Record<AccessDeniedReason, ApiErrorBody> = {
	CREDENTIAL_REQUIRED: { message: 'Credential required.', code: 'CREDENTIAL_REQUIRED', id: '1384574d-a912-4b81-8601-c7b1c4085df1', status: 401 },
	YOUR_ACCOUNT_SUSPENDED: { message: 'Your account has been suspended.', code: 'YOUR_ACCOUNT_SUSPENDED', id: 'a8c724b3-6e9c-4b46-b1a8-bc3ed6258370', kind: 'permission' },
	MODERATOR_REQUIRED: { message: 'You are not assigned to a moderator role.', code: 'ROLE_PERMISSION_DENIED', id: 'd33d5333-db36-423d-a8f9-1a2b9549da41', kind: 'permission' },
	ADMINISTRATOR_REQUIRED: { message: 'You are not assigned to an administrator role.', code: 'ROLE_PERMISSION_DENIED', id: 'c3d38592-54c0-429d-be96-5636b0431a61', kind: 'permission' },
	PERMISSION_DENIED: { message: 'Your app does not have the necessary permissions to use this endpoint.', code: 'PERMISSION_DENIED', id: '1370e5b7-d4eb-4566-bb1d-7748ee6a1838', kind: 'permission' },
};

/** 全endpoint共通のエラー。endpoint固有のエラーは各endpointの対応表で先に変換する。 */
export function commonApiError(error: unknown): ApiErrorBody | undefined {
	if (error instanceof AccessDenied) {
		return accessDenied[error.reason];
	}
	if (error instanceof AuthenticationFailed) {
		return AUTHENTICATION_FAILED;
	}
	if (error instanceof InputInvalid) {
		return { message: 'Invalid param.', code: 'INVALID_PARAM', id: '3d81ceae-475f-4600-b2a8-2bc116157532', info: { param: error.param, reason: error.reason } };
	}
	return undefined;
}

/** 本家ApiCallServiceの#sendApiError・#sendAuthenticationErrorと同じ優先順位でstatusとheaderを決める。 */
export function apiErrorResponse(error: ApiErrorBody, now = Date.now()): Response {
	const { status: explicitStatus, kind = 'client', info, ...rest } = error;
	const headers = new Headers();
	let status = explicitStatus;
	if (error.code === 'AUTHENTICATION_FAILED') {
		headers.set('WWW-Authenticate', `Bearer realm="Misskey", error="invalid_token", error_description="${error.message}"`);
	} else if (status === 401) {
		headers.set('WWW-Authenticate', 'Bearer realm="Misskey"');
	} else if (error.code === 'RATE_LIMIT_EXCEEDED') {
		if (info !== undefined && 'resetMs' in info && typeof info.resetMs === 'number') {
			headers.set('Retry-After', Math.max(Math.ceil((info.resetMs - now) / 1000), 0).toString());
		}
	} else if (kind === 'client') {
		headers.set('WWW-Authenticate', `Bearer realm="Misskey", error="invalid_request", error_description="${error.message}"`);
		status ??= 400;
	} else if (kind === 'permission') {
		if (error.code === 'PERMISSION_DENIED') {
			headers.set('WWW-Authenticate', `Bearer realm="Misskey", error="insufficient_scope", error_description="${error.message}"`);
		}
		status ??= 403;
	}
	return Response.json({ error: { ...rest, kind, ...(info ? { info } : {}) } }, { status: status ?? 500, headers });
}
