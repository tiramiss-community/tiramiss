/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineJob } from '@mokurokujs/core';
import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import { httpRelatedBackoff } from '../backoff.js';
import type { UserWebhookDeliverJobData, SystemWebhookDeliverJobData } from '../../types.js';

const config = loadConfig();

/**
 * User Webhook Deliver Queue の定義。
 */
export const userWebhookDeliverQueue = defineQueueForBullMQ(QUEUE.USER_WEBHOOK_DELIVER, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.USER_WEBHOOK_DELIVER),
	},
	workerOptions: {
		autorun: false,
		concurrency: 64,
		limiter: {
			max: 64,
			duration: 1000,
		},
		settings: {
			backoffStrategy: httpRelatedBackoff,
		},
		...baseWorkerOptions(config, QUEUE.USER_WEBHOOK_DELIVER),
	},
}).build();

/**
 * System Webhook Deliver Queue の定義。
 */
export const systemWebhookDeliverQueue = defineQueueForBullMQ(QUEUE.SYSTEM_WEBHOOK_DELIVER, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.SYSTEM_WEBHOOK_DELIVER),
	},
	workerOptions: {
		autorun: false,
		concurrency: 16,
		limiter: {
			max: 16,
			duration: 1000,
		},
		settings: {
			backoffStrategy: httpRelatedBackoff,
		},
		...baseWorkerOptions(config, QUEUE.SYSTEM_WEBHOOK_DELIVER),
	},
}).build();

/** 共通の削除ポリシー */
const defaultRemovePolicy = {
	removeOnComplete: {
		age: 3600 * 24 * 7, // 7 days
		count: 30,
	},
	removeOnFail: {
		age: 3600 * 24 * 7, // 7 days
		count: 100,
	},
} as const;

export const userWebhookDeliverJob = defineJob<UserWebhookDeliverJobData>('userWebhookDeliver', {
	queue: userWebhookDeliverQueue,
	attempts: 4,
	backoff: { type: 'custom' },
	...defaultRemovePolicy,
});

export const systemWebhookDeliverJob = defineJob<SystemWebhookDeliverJobData>('systemWebhookDeliver', {
	queue: systemWebhookDeliverQueue,
	attempts: 4,
	backoff: { type: 'custom' },
	...defaultRemovePolicy,
});
