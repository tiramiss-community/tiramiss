/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { ActorNotFound, ActorSuspended, AdministratorRequired, ModeratorRequired, CredentialScopeDenied, RoleNotFound, RoleInputInvalid } from '../modules/role/public.js';
import { AuthenticationFailed, CredentialRequired } from './authentication-error.js';

export function apiErrorResponse(error: unknown, operation: 'show' | 'update'): Response {
	let status = 500;
	let body: { message: string; code: string; id: string; kind: string; info?: object } = {
		message: 'Internal error occurred. Please contact us if the error persists.', code: 'INTERNAL_ERROR',
		id: '5d37dbcb-891e-41ca-a3d6-e690c97775ac', kind: 'server',
	};
	let authenticate: string | undefined;
	if (error instanceof CredentialRequired) {
		status = 401;
		body = { message: 'Credential required.', code: 'CREDENTIAL_REQUIRED', id: '1384574d-a912-4b81-8601-c7b1c4085df1', kind: 'client' };
		authenticate = 'Bearer realm="Misskey"';
	} else if (error instanceof AuthenticationFailed || error instanceof ActorNotFound) {
		status = 401;
		body = { message: 'Authentication failed. Please ensure your token is correct.', code: 'AUTHENTICATION_FAILED', id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14', kind: 'client' };
		authenticate = `Bearer realm="Misskey", error="invalid_token", error_description="${body.message}"`;
	} else if (error instanceof ActorSuspended) {
		status = 403;
		body = { message: 'Your account has been suspended.', code: 'YOUR_ACCOUNT_SUSPENDED', id: 'a8c724b3-6e9c-4b46-b1a8-bc3ed6258370', kind: 'permission' };
	} else if (error instanceof AdministratorRequired || error instanceof ModeratorRequired) {
		status = 403;
		body = operation === 'show'
			? { message: 'You are not assigned to a moderator role.', code: 'ROLE_PERMISSION_DENIED', id: 'd33d5333-db36-423d-a8f9-1a2b9549da41', kind: 'permission' }
			: { message: 'You are not assigned to an administrator role.', code: 'ROLE_PERMISSION_DENIED', id: 'c3d38592-54c0-429d-be96-5636b0431a61', kind: 'permission' };
	} else if (error instanceof CredentialScopeDenied) {
		status = 403;
		body = { message: 'Your app does not have the necessary permissions to use this endpoint.', code: 'PERMISSION_DENIED', id: '1370e5b7-d4eb-4566-bb1d-7748ee6a1838', kind: 'permission' };
		authenticate = `Bearer realm="Misskey", error="insufficient_scope", error_description="${body.message}"`;
	} else if (error instanceof RoleNotFound || error instanceof RoleInputInvalid) {
		status = 400;
		body = error instanceof RoleNotFound
			? { message: 'No such role.', code: 'NO_SUCH_ROLE', id: operation === 'show' ? '07dc7d34-c0d8-49b7-96c6-db3ce64ee0b3' : 'cd23ef55-09ad-428a-ac61-95a45e124b32', kind: 'client' }
			: { message: 'Invalid param.', code: 'INVALID_PARAM', id: '3d81ceae-475f-4600-b2a8-2bc116157532', kind: 'client', info: { param: error.param, reason: error.reason } };
		authenticate = `Bearer realm="Misskey", error="invalid_request", error_description="${body.message}"`;
	}
	return Response.json({ error: body }, { status, headers: authenticate ? { 'WWW-Authenticate': authenticate } : undefined });
}
