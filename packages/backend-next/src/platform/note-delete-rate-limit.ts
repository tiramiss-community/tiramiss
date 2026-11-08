/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { NoteDeleteError } from '../modules/note/public.js';
import { createApiRateLimiter } from './api-rate-limit.js';
import type { Redis } from 'ioredis';

export function createNoteDeleteRateLimiter(redis: Redis) {
	const limit = createApiRateLimiter(redis);
	return async (userId: string, factor: number): Promise<void> => {
		const exceeded = await limit({ key: 'notes/delete', duration: 60 * 60 * 1000, max: 300, minInterval: 1000 }, userId, factor);
		if (exceeded) {
			throw new NoteDeleteError('RATE_LIMIT_EXCEEDED', exceeded);
		}
	};
}
