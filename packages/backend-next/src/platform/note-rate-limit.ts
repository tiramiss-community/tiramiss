/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import Limiter from 'ratelimiter';
import { NoteCreateError } from '../modules/note/public.js';
import type { Redis } from 'ioredis';

export function createNoteRateLimiter(redis: Redis) {
	const enabled = process.env.NODE_ENV === 'production';
	return async (userId: string, factor: number): Promise<void> => {
		if (!enabled || factor <= 0) {
			return;
		}
		const info = await new Promise<Limiter.LimiterInfo>((resolve, reject) => {
			new Limiter({ db: redis, id: `${userId}:notes/create`, duration: 60 * 60 * 1000, max: 300 / factor }).get((error, result) => {
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			});
		});
		if (info.remaining === 0) {
			throw new NoteCreateError('RATE_LIMIT_EXCEEDED', info);
		}
	};
}
