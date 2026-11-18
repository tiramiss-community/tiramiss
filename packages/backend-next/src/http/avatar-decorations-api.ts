/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createApiEndpoints } from './api-endpoint.js';
import { compileInput } from '../modules/access/public.js';
import type { createPublicAvatarDecorations } from '../modules/avatar-decoration/public.js';
import type { ApiEndpointsOptions } from './api-endpoint.js';

const input = compileInput({ type: 'object', properties: {}, required: [] });

export function createAvatarDecorationsApi(list: ReturnType<typeof createPublicAvatarDecorations>, options: Omit<ApiEndpointsOptions, 'endpoints'>) {
	return createApiEndpoints({ ...options, endpoints: [{
		name: 'get-avatar-decorations', access: {},
		handle: async (access, value) => {
			input(value);
			return list(access.credential !== null);
		},
	}] });
}
