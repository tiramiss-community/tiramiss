/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from './diagnostic-error.js';
import type { FeaturedNoteScore } from '../modules/note/public.js';
import type { Redis } from 'ioredis';

const epoch = Date.parse('2023-01-01T00:00:00Z');

export function createFeaturedRanking(redis: Redis, currentTime: () => number) {
	return {
		async add(score: FeaturedNoteScore): Promise<void> {
			const range = score.kind === 'user' ? 604800000 : 259200000;
			const name = score.kind === 'global' ? 'featuredGlobalNotesRanking'
				: score.kind === 'channel' ? `featuredInChannelNotesRanking:${score.channelId}`
					: `featuredPerUserNotesRanking:${score.userId}`;
			// Each independent MULTI observes its own execution time, as in FeaturedService.
			const key = `${name}:${Math.floor((currentTime() - epoch) / range)}`;
			const result = await redis.multi().zincrby(key, 5, score.noteId).expire(key, range * 3 / 1000, 'NX').exec();
			// EXEC may resolve successfully while individual commands have failed.
			const failures = result?.flatMap(([error], index) => error ? [{ command: index === 0 ? 'zincrby' : 'expire', error }] : []) ?? [{ command: 'exec', error: new Error('Transaction aborted') }];
			if (failures.length > 0) {
				throw new DiagnosticError('NOTE_FEATURED_REDIS_FAILED', { kind: score.kind, noteId: score.noteId, key, failures });
			}
		},
	};
}
