/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import type { IEndpointMeta } from '@/server/api/endpoints.js';
import { LoggerService } from '@/core/LoggerService.js';
import { TimeService } from '@/core/TimeService.js';
import { EnvService } from '@/core/EnvService.js';
import { DI } from '@/di-symbols.js';
import { RateLimiterService } from './RateLimiterService.js';

/**
 * Metadata about the current status of a rate limiter
 */
export interface LimitInfo {
	/**
	 * True if the limit has been reached, and the call should be blocked.
	 */
	blocked: boolean;

	/**
	 * Number of calls that can be made before the limit is triggered.
	 */
	remaining: number;

	/**
	 * Time in seconds until the next call can be made, or zero if the next call can be made immediately.
	 * Rounded up to the nearest second.
	 */
	resetSec: number;

	/**
	 * Time in milliseconds until the next call can be made, or zero if the next call can be made immediately.
	 * Rounded up to the nearest milliseconds.
	 */
	resetMs: number;

	/**
	 * Time in seconds until the limit has fully reset.
	 * Rounded up to the nearest second.
	 */
	fullResetSec: number;

	/**
	 * Time in milliseconds until the limit has fully reset.
	 * Rounded up to the nearest millisecond.
	 */
	fullResetMs: number;
}

export function isLimitInfo(info: unknown): info is LimitInfo {
	if (info == null) return false;
	if (typeof(info) !== 'object') return false;
	if (!('blocked' in info) || typeof(info.blocked) !== 'boolean') return false;
	if (!('remaining' in info) || typeof(info.remaining) !== 'number') return false;
	if (!('resetSec' in info) || typeof(info.resetSec) !== 'number') return false;
	if (!('resetMs' in info) || typeof(info.resetMs) !== 'number') return false;
	if (!('fullResetSec' in info) || typeof(info.fullResetSec) !== 'number') return false;
	if (!('fullResetMs' in info) || typeof(info.fullResetMs) !== 'number') return false;
	return true;
}

/**
 * Rate limit based on "leaky bucket" logic.
 * The bucket count increases with each call, and decreases gradually at a given rate.
 * The subject is blocked until the bucket count drops below the limit.
 */
export interface RateLimit {
	/**
	 * Unique key identifying the particular resource (or resource group) being limited.
	 */
	key: string;

	/**
	 * Constant value identifying the type of rate limit.
	 */
	type: 'bucket';

	/**
	 * Size of the bucket, in number of requests.
	 * The subject will be blocked when the number of calls exceeds this size.
	 */
	size: number;

	/**
	 * How often the bucket should "drip" and reduce the counter, measured in milliseconds.
	 * Defaults to 1000 (1 second).
	 */
	dripRate?: number;

	/**
	 * Amount to reduce the counter on each drip.
	 * Defaults to 1.
	 */
	dripSize?: number;
}

export type SupportedRateLimit = RateLimit | LegacyRateLimit;
export type LegacyRateLimit = IEndpointMeta['limit'] & { key: NonNullable<string>, type: undefined | 'legacy' };

export function isLegacyRateLimit(limit: SupportedRateLimit): limit is LegacyRateLimit {
	return limit.type === undefined || limit.type === 'legacy';
}

export function hasMinLimit(limit: LegacyRateLimit): limit is LegacyRateLimit & { minInterval: number } {
	return !!limit.minInterval;
}

@Injectable()
export class SkRateLimiterService extends RateLimiterService {
	constructor(
		@Inject(TimeService)
		private readonly timeService: TimeService,

		@Inject(DI.redis)
		redisClient: Redis.Redis,

		@Inject(LoggerService)
		loggerService: LoggerService,

		@Inject(EnvService)
		envService: EnvService,
	) {
		super(redisClient, loggerService, envService);
	}

	public async limit(limit: SupportedRateLimit, actor: string, factor = 1): Promise<LimitInfo> {
		if (this.disabled) {
			return {
				blocked: false,
				remaining: Number.MAX_SAFE_INTEGER,
				resetSec: 0,
				resetMs: 0,
				fullResetSec: 0,
				fullResetMs: 0,
			};
		}

		if (isLegacyRateLimit(limit)) {
			return await this.limitLegacy(limit, actor, factor);
		} else {
			return await this.limitBucket(limit, actor, factor);
		}
	}

	private async limitLegacy(limit: LegacyRateLimit, actor: string, factor: number): Promise<LimitInfo> {
		const promises: Promise<LimitInfo | null>[] = [];

		// The "min" limit - if present - is handled directly.
		if (hasMinLimit(limit)) {
			promises.push(
				this.limitMin(limit, actor, factor),
			);
		}

		// Convert the "max" limit into a leaky bucket with 1 drip / second rate.
		if (limit.max && limit.duration) {
			promises.push(
				this.limitBucket({
					type: 'bucket',
					key: limit.key,
					size: limit.max,
					dripRate: Math.round(limit.duration / limit.max),
				}, actor, factor),
			);
		}

		const [lim1, lim2] = await Promise.all(promises);
		return {
			blocked: (lim1?.blocked || lim2?.blocked) ?? false,
			remaining: Math.min(lim1?.remaining ?? 1, lim2?.remaining ?? 1),
			resetSec: Math.max(lim1?.resetSec ?? 0, lim2?.resetSec ?? 0),
			resetMs: Math.max(lim1?.resetMs ?? 0, lim2?.resetMs ?? 0),
			fullResetSec: Math.max(lim1?.fullResetSec ?? 0, lim2?.fullResetSec ?? 0),
			fullResetMs: Math.max(lim1?.fullResetMs ?? 0, lim2?.fullResetMs ?? 0),
		};
	}

	private async limitMin(limit: LegacyRateLimit & { minInterval: number }, actor: string, factor: number): Promise<LimitInfo | null> {
		const counter = await this.getLimitCounter(limit, actor, 'min');
		const maxCalls = Math.max(Math.ceil(factor), 1);

		// Update expiration
		if (counter.c >= maxCalls) {
			const isCleared = this.timeService.now - counter.t >= limit.minInterval;
			if (isCleared) {
				counter.c = 0;
			}
		}

		const blocked = counter.c >= maxCalls;
		if (!blocked) {
			counter.c++;
			counter.t = this.timeService.now;
		}

		// Calculate limit status
		const remaining = Math.max(maxCalls - counter.c, 0);
		const fullResetMs = Math.max(Math.ceil(limit.minInterval - (this.timeService.now - counter.t)), 0);
		const fullResetSec = Math.ceil(fullResetMs / 1000);
		const resetMs = remaining < 1 ? fullResetMs : 0;
		const resetSec = remaining < 1 ? fullResetSec : 0;
		const limitInfo: LimitInfo = { blocked, remaining, resetSec, resetMs, fullResetSec, fullResetMs,
		};

		// Update the limit counter, but not if blocked
		if (!blocked) {
			// Don't await, or we will slow down the API.
			this.setLimitCounter(limit, actor, counter, resetMs, 'min')
				.catch(err => this.logger.error(`Failed to update limit ${limit.key}:min for ${actor}:`, err));
		}

		return limitInfo;
	}

	private async limitBucket(limit: RateLimit, actor: string, factor: number): Promise<LimitInfo> {
		const counter = await this.getLimitCounter(limit, actor);
		const dripRate = (limit.dripRate ?? 1000);
		const dripSize = (limit.dripSize ?? 1);
		const bucketSize = (limit.size * factor);

		// Update drips
		if (counter.c > 0) {
			const dripsSinceLastTick = Math.floor((this.timeService.now - counter.t) / dripRate) * dripSize;
			counter.c = Math.max(counter.c - dripsSinceLastTick, 0);
		}

		const blocked = counter.c >= bucketSize;
		if (!blocked) {
			counter.c++;
			counter.t = this.timeService.now;
		}

		// Calculate limit status
		const remaining = Math.max(bucketSize - counter.c, 0);
		const resetMs = remaining > 0 ? 0 : Math.max(dripRate - (this.timeService.now - counter.t), 0);
		const resetSec = Math.ceil(resetMs / 1000);
		const fullResetMs = Math.ceil(counter.c / dripSize) * dripRate;
		const fullResetSec = Math.ceil(fullResetMs / 1000);
		const limitInfo: LimitInfo = { blocked, remaining, resetSec, resetMs, fullResetSec, fullResetMs };

		// Update the limit counter, but not if blocked
		if (!blocked) {
			// Don't await, or we will slow down the API.
			this.setLimitCounter(limit, actor, counter, fullResetMs)
				.catch(err => this.logger.error(`Failed to update limit ${limit.key} for ${actor}:`, err));
		}

		return limitInfo;
	}

	private async getLimitCounter(limit: SupportedRateLimit, actor: string, subject?: string): Promise<LimitCounter> {
		const key = createLimitKey(limit, actor, subject);

		const value = await this.redisClient.get(key);
		if (value == null) {
			return { t: 0, c: 0 };
		}

		return JSON.parse(value);
	}

	private async setLimitCounter(limit: SupportedRateLimit, actor: string, counter: LimitCounter, expirationMs: number, subject?: string): Promise<void> {
		const key = createLimitKey(limit, actor, subject);
		const value = JSON.stringify(counter);
		await this.redisClient.set(key, value, 'PX', expirationMs);
	}
}

function createLimitKey(limit: SupportedRateLimit, actor: string, subject?: string): string {
	if (subject) {
		return `rl_${actor}_${limit.key}_${subject}`;
	} else {
		return `rl_${actor}_${limit.key}`;
	}
}

export interface LimitCounter {
	/** Timestamp */
	t: number;

	/** Counter */
	c: number;
}
