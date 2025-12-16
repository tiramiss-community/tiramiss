/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type { RelationshipJobData } from '../../types.js';

const config = loadConfig();

/**
 * Relationship Queue の定義。
 * フォロー/ブロック等のリレーション処理を行うためのキュー。
 */
export const relationshipQueue = defineQueueForBullMQ(QUEUE.RELATIONSHIP, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.RELATIONSHIP),
	},
	workerOptions: {
		autorun: false,
		concurrency: config.relationshipJobConcurrency ?? 16,
		limiter: {
			max: config.relationshipJobPerSec ?? 64,
			duration: 1000,
		},
		...baseWorkerOptions(config, QUEUE.RELATIONSHIP),
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

export const followJob = defineJob<RelationshipJobData>('follow', {
	queue: relationshipQueue,
	...defaultRemovePolicy,
});

export const unfollowJob = defineJob<RelationshipJobData>('unfollow', {
	queue: relationshipQueue,
	...defaultRemovePolicy,
});

export const blockJob = defineJob<RelationshipJobData>('block', {
	queue: relationshipQueue,
	...defaultRemovePolicy,
});

export const unblockJob = defineJob<RelationshipJobData>('unblock', {
	queue: relationshipQueue,
	...defaultRemovePolicy,
});
