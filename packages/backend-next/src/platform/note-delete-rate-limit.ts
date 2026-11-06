/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import Limiter from 'ratelimiter';
import { NoteDeleteError } from '../modules/note/public.js';
import type { Redis } from 'ioredis';

export function createNoteDeleteRateLimiter(redis: Redis) {
	const enabled = process.env.NODE_ENV === 'production';
	return async (userId: string, factor: number): Promise<void> => {
		if (!enabled || factor <= 0) {
			return;
		}
		// 本家の短期枠を先に消費し、超過したときは長期枠を消費しない。
		for (const window of [{ id: `${userId}:notes/delete:min`, duration: 1000 * factor, max: 1 }, { id: `${userId}:notes/delete`, duration: 3600000, max: 300 / factor }]) {
			const info = await new Promise<Limiter.LimiterInfo>((resolve, reject) => {
				new Limiter({ ...window, db: redis }).get((error, result) => {
					if (error) {
						reject(error);
					} else {
						resolve(result);
					}
				});
			});
			if (info.remaining === 0) {
				throw new NoteDeleteError('RATE_LIMIT_EXCEEDED', info);
			}
		}
	};
}
