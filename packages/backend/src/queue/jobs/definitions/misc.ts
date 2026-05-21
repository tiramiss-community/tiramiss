/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type { EndedPollNotificationJobData, PostScheduledNoteJobData } from '../../types.js';

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

// ==================== Ended Poll Notification ====================

/**
 * EndedPollNotification Queue の定義。
 * 投票終了通知を送信するためのキュー。
 */
export const endedPollNotificationQueue = defineQueueForBullMQ(QUEUE.ENDED_POLL_NOTIFICATION, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.ENDED_POLL_NOTIFICATION),
	},
	workerOptions: {
		autorun: false,
		...baseWorkerOptions(config, QUEUE.ENDED_POLL_NOTIFICATION),
	},
}).build();

export const endedPollNotificationJob = defineJob<EndedPollNotificationJobData>('endedPollNotification', {
	queue: endedPollNotificationQueue,
	...defaultRemovePolicy,
});

// ==================== Post Scheduled Note ====================

/**
 * PostScheduledNote Queue の定義。
 * 予約投稿を処理するためのキュー。
 */
export const postScheduledNoteQueue = defineQueueForBullMQ(QUEUE.POST_SCHEDULED_NOTE, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.POST_SCHEDULED_NOTE),
	},
	workerOptions: {
		autorun: false,
		...baseWorkerOptions(config, QUEUE.POST_SCHEDULED_NOTE),
	},
}).build();

export const postScheduledNoteJob = defineJob<PostScheduledNoteJobData>('postScheduledNote', {
	queue: postScheduledNoteQueue,
	...defaultRemovePolicy,
});
