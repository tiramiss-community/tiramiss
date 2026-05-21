/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import { httpRelatedBackoff } from '../backoff.js';
import type { DeliverJobData } from '../../types.js';

const config = loadConfig();

/**
 * Deliver Queue の定義。
 * ActivityPub のアクティビティを他サーバーに配送するためのキュー。
 */
export const deliverQueue = defineQueueForBullMQ(QUEUE.DELIVER, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.DELIVER),
	},
	workerOptions: {
		autorun: false,
		concurrency: config.deliverJobConcurrency ?? 128,
		limiter: {
			max: config.deliverJobPerSec ?? 128,
			duration: 1000,
		},
		settings: {
			backoffStrategy: httpRelatedBackoff,
		},
		...baseWorkerOptions(config, QUEUE.DELIVER),
	},
}).build();

/**
 * Deliver ジョブの定義。
 *
 * このジョブは ActivityPub のアクティビティを指定された inbox に配送する。
 */
export const deliverJob = defineJob<DeliverJobData>('deliver', {
	queue: deliverQueue,
	attempts: config.deliverJobMaxAttempts ?? 12,
	backoff: { type: 'custom' },
	removeOnComplete: {
		age: 3600 * 24 * 7, // 7 days
		count: 30,
	},
	removeOnFail: {
		age: 3600 * 24 * 7, // 7 days
		count: 100,
	},
});
