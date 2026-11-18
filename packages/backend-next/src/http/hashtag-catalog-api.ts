/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { HashtagMissing } from '../modules/hashtag/catalog.js';
import type { createHashtagCatalog } from '../modules/hashtag/catalog.js';
import type { ApiEndpoint } from './api-endpoint.js';

export function createHashtagCatalogEndpoints(application: ReturnType<typeof createHashtagCatalog>): ApiEndpoint[] {
	return [
		{ name: 'hashtags/list', access: { requireCredential: false }, handle: (_access, input) => application.list(input) },
		{ name: 'hashtags/search', access: { requireCredential: false }, handle: (_access, input) => application.search(input) },
		{
			name: 'hashtags/show', access: { requireCredential: false }, handle: (_access, input) => application.show(input),
			errors: error => error instanceof HashtagMissing ? { message: error.message, code: error.code, id: error.id } : undefined,
		},
	];
}
