/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type { NotePiningDeliverJobData } from '@/queue/types.js';

const config = loadConfig();

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

export const notePiningDeliverQueue = defineQueueForBullMQ(QUEUE.NOTE_PINING_DELIVER, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.NOTE_PINING_DELIVER),
	},
	workerOptions: {
		autorun: false,
		concurrency: 4,
		...baseWorkerOptions(config, QUEUE.NOTE_PINING_DELIVER),
	},
}).build();

export const notePiningDeliverJob = defineJob<NotePiningDeliverJobData>('notePiningDeliver', {
	queue: notePiningDeliverQueue,
	attempts: 2,
	...defaultRemovePolicy,
});
