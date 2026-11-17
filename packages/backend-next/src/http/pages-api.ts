/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { PageMissing } from '../modules/page/public.js';
import type { createPageReader } from '../modules/page/public.js';
import type { ApiEndpoint } from './api-endpoint.js';
export function createPageEndpoints(reader: ReturnType<typeof createPageReader>): ApiEndpoint[] {
	return [{
		name: 'pages/show', access: { requireCredential: false },
		handle: (access, input) => reader.show(access, input, Date.now()),
		errors: error => error instanceof PageMissing ? { code: error.code, id: error.id, message: error.message } : undefined,
	}];
}
