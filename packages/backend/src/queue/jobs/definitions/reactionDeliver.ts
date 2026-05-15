/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type { ReactionDeliverJobData } from '@/queue/types.js';

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

export const reactionDeliverQueue = defineQueueForBullMQ(QUEUE.REACTION_DELIVER, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.REACTION_DELIVER),
	},
	workerOptions: {
		autorun: false,
		concurrency: 4,
		...baseWorkerOptions(config, QUEUE.REACTION_DELIVER),
	},
}).build();

export const reactionDeliverJob = defineJob<ReactionDeliverJobData>('reactionDeliver', {
	queue: reactionDeliverQueue,
	attempts: 2,
	...defaultRemovePolicy,
});
