/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { createUserRelation } from '../modules/user-relation/public.js';
import type { ApiEndpoint } from './api-endpoint.js';

export function createUserRelationEndpoints(application: ReturnType<typeof createUserRelation>): ApiEndpoint[] {
	return [{ name: 'users/relation', access: { requireCredential: true, kind: 'read:account' }, handle: (access, input) => application.read(access, input) }];
}
