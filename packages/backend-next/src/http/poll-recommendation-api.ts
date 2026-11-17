/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createApiEndpoints } from './api-endpoint.js';
import type { AccessCredential, AccessRequest } from '../modules/access/public.js';
import type { JsonObject } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

export function createPollRecommendationApi(dependencies: {
	authenticate(token: string | null | undefined): Promise<{ credential: AccessCredential } | null>;
	recommendPolls(access: AccessRequest, input: unknown, now: number): Promise<JsonObject[]>;
	logger: Logger;
}) {
	return createApiEndpoints({ ...dependencies, endpoints: [{
		name: 'notes/polls/recommendation',
		access: { requireCredential: true, kind: 'read:account' },
		handle: (access, input) => dependencies.recommendPolls(access, input, Date.now()),
	}] });
}
