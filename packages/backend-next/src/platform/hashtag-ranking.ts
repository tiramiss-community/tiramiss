/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { canRankHashtag } from '../modules/note/public.js';
import { DiagnosticError } from './diagnostic-error.js';
import type { HashtagMention, HashtagRankingSettings } from '../modules/note/public.js';
import type { Redis } from 'ioredis';

const epoch = Date.parse('2023-01-01T00:00:00Z');

export function createHashtagRanking(redis: Redis, currentTime: () => number) {
	return {
		async update(mention: HashtagMention, settings: HashtagRankingSettings): Promise<void> {
			const { tag, userId } = mention;
			if (!canRankHashtag(tag, settings)) {
				return;
			}
			const now = new Date(currentTime());
			now.setMinutes(Math.floor(now.getMinutes() / 10) * 10, 0, 0);
			const window = `${now.getUTCFullYear()}${[now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()].map(value => value.toString().padStart(2, '0')).join('')}`;
			const uniqueKey = `hashtagUsers:${tag}`;
			if (await redis.sismember(uniqueKey, userId) === 1) {
				return;
			}
			const chartKey = `${uniqueKey}:${window}`;
			const featuredKey = `featuredHashtagsRanking:${Math.floor((currentTime() - epoch) / 3600000)}`;
			const failures: { step: string; error: unknown }[] = [];
			const start = (step: string, run: () => Promise<[Error | null, unknown][] | null>) => {
				try {
					return run().then(result => {
						const errors = result?.flatMap(([error], command) => error ? [{ command, error }] : []) ?? [{ command: -1, error: new Error('EXEC aborted') }];
						if (errors.length > 0) {
							throw new DiagnosticError('NOTE_HASHTAG_COMMAND_FAILED', { step, errors });
						}
					}).catch(error => {
						failures.push({ step, error });
					});
				} catch (error) {
					failures.push({ step, error });
					return Promise.resolve();
				}
			};
			const featured = start('featured', () => redis.multi().zincrby(featuredKey, 1, tag).expire(featuredKey, 10800, 'NX').exec());
			const chart = start('chart', () => redis.pipeline().pfadd(chartKey, userId).expire(chartKey, 259200, 'NX').sadd(uniqueKey, userId).expire(uniqueKey, 3600, 'NX').exec());
			await Promise.all([featured, chart]);
			if (failures.length > 0) {
				throw new DiagnosticError('NOTE_HASHTAG_REDIS_FAILED', { tag, userId, featuredKey, chartKey, failures });
			}
		},
	};
}
