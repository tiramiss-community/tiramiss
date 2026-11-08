/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { NoteCreateError } from '../modules/note/public.js';
import { createApiRateLimiter } from './api-rate-limit.js';
import type { Redis } from 'ioredis';

export function createNoteRateLimiter(redis: Redis) {
	const limit = createApiRateLimiter(redis);
	return async (userId: string, factor: number): Promise<void> => {
		const exceeded = await limit({ key: 'notes/create', duration: 60 * 60 * 1000, max: 300 }, userId, factor);
		if (exceeded) {
			throw new NoteCreateError('RATE_LIMIT_EXCEEDED', exceeded);
		}
	};
}
