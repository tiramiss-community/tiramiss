/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { apiErrorResponse } from '../../src/http/api-error.js';
import { WorkCapacityExceeded } from '../../src/modules/post-work/public.js';
test('returns the agreed 503 contract for temporarily unavailable capacity', async () => {
	const response = apiErrorResponse(new WorkCapacityExceeded('low or unknown volume'), 'update');
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: { code: 'BACKEND_BUSY', id: '3ba27d7e-a4eb-4ae9-89ad-152bc40aad2d', message: 'The server is temporarily busy. Please try again later.', kind: 'server' } });
});
