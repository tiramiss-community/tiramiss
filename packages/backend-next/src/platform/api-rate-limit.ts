/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import Limiter from 'ratelimiter';
import type { Redis } from 'ioredis';

/** 本家endpoint metaの`limit`。`key`の既定値はendpoint名。 */
export interface ApiRateLimit {
	key: string;
	duration?: number;
	max?: number;
	minInterval?: number;
}

export type ApiRateLimitInfo = Limiter.LimiterInfo;

/**
 * 本家RateLimiterServiceと同じRedisの窓（`limit:<actor>:<key>:min`→`limit:<actor>:<key>`）を消費し、
 * 超過した窓の情報を返す。本家と同じく本番環境でだけ有効にする。
 */
export function createApiRateLimiter(redis: Redis) {
	const enabled = process.env.NODE_ENV === 'production';
	const consume = (id: string, duration: number, max: number) => new Promise<ApiRateLimitInfo>((resolve, reject) => {
		new Limiter({ db: redis, id, duration, max }).get((error, result) => {
			if (error) {
				reject(error);
			} else {
				resolve(result);
			}
		});
	});

	return async (limit: ApiRateLimit, actorId: string, factor: number): Promise<ApiRateLimitInfo | null> => {
		if (!enabled || factor <= 0) {
			return null;
		}

		// 短期枠を超過したときは長期枠を消費しない。
		if (limit.minInterval !== undefined) {
			const info = await consume(`${actorId}:${limit.key}:min`, limit.minInterval * factor, 1);
			if (info.remaining === 0) {
				return info;
			}
		}
		if (limit.duration !== undefined && limit.max !== undefined) {
			const info = await consume(`${actorId}:${limit.key}`, limit.duration, limit.max / factor);
			if (info.remaining === 0) {
				return info;
			}
		}
		return null;
	};
}
