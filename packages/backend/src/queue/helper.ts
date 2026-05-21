/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MetricsTime } from 'bullmq';
import type { Config } from '@/config.js';
import { QUEUE, type QueueType } from '@/queue/const.js';
import type * as Bull from 'bullmq';

export function baseQueueOptions(config: Config, queueName: QueueType): Bull.QueueOptions {
	const redisForThisQueue = config.redisForJobQueueByQueue?.[queueName] ?? config.redisForJobQueue;
	return {
		connection: {
			...redisForThisQueue,
			keyPrefix: undefined,
		},
		prefix: redisForThisQueue.prefix ? `${redisForThisQueue.prefix}:queue:${queueName}` : `queue:${queueName}`,
	};
}

export function baseWorkerOptions(config: Config, queueName: typeof QUEUE[keyof typeof QUEUE]): Bull.WorkerOptions {
	return {
		...baseQueueOptions(config, queueName),
		metrics: {
			maxDataPoints: MetricsTime.ONE_WEEK,
		},
	};
}

