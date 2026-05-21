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
import type { InboxJobData } from '../../types.js';

const config = loadConfig();

/**
 * Inbox Queue の定義。
 * 他サーバーから受信した ActivityPub アクティビティを処理するためのキュー。
 */
export const inboxQueue = defineQueueForBullMQ(QUEUE.INBOX, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.INBOX),
	},
	workerOptions: {
		autorun: false,
		concurrency: config.inboxJobConcurrency ?? 16,
		limiter: {
			max: config.inboxJobPerSec ?? 32,
			duration: 1000,
		},
		settings: {
			backoffStrategy: httpRelatedBackoff,
		},
		...baseWorkerOptions(config, QUEUE.INBOX),
	},
}).build();

/**
 * Inbox ジョブの定義。
 */
export const inboxJob = defineJob<InboxJobData>('inbox', {
	queue: inboxQueue,
	attempts: config.inboxJobMaxAttempts ?? 8,
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
