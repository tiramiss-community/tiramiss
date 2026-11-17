/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { UserMemoTargetMissing } from '../modules/user-memo/public.js';
import type { createUserMemo } from '../modules/user-memo/public.js';
import type { ApiEndpoint } from './api-endpoint.js';

export function createUserMemoEndpoints(application: ReturnType<typeof createUserMemo>): ApiEndpoint[] {
	return [{
		name: 'users/update-memo',
		access: { requireCredential: true, kind: 'write:account' },
		handle: (access, input) => application.update(access, input),
		errors: error => error instanceof UserMemoTargetMissing ? { message: error.message, code: error.code, id: error.id } : undefined,
	}];
}
