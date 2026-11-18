/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { PromoError } from '../modules/promo/public.js';
import type { createPromo } from '../modules/promo/public.js';
import type { ApiEndpoint } from './api-endpoint.js';

export function createPromoEndpoints(application: ReturnType<typeof createPromo>): ApiEndpoint[] {
	return [{
		name: 'admin/promo/create',
		access: { requireCredential: true, requireModerator: true, kind: 'write:admin:promo' },
		handle: (access, input) => application.create(access, input),
		errors: error => error instanceof PromoError ? { message: error.message, code: error.code, id: error.id } : undefined,
	}];
}
