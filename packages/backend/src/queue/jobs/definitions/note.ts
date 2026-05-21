/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type { NotePostJobData, UpdateUserNotesCountJobData } from '@/queue/types.js';

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

export const notePostQueue = defineQueueForBullMQ(QUEUE.NOTE_POST, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.NOTE_POST),
	},
	workerOptions: {
		autorun: false,
		concurrency: 4,
		...baseWorkerOptions(config, QUEUE.NOTE_POST),
	},
}).build();

export const notePostJob = defineJob<NotePostJobData>('notePost', {
	queue: notePostQueue,
	attempts: 2,
	...defaultRemovePolicy,
});

export const updateUserNotesCountJob = defineJob<UpdateUserNotesCountJobData>('updateUserNotesCount', {
	queue: notePostQueue,
	attempts: 2,
	// 完了即削除: jobId dedup が completed 状態でもブロックしないよう removeOnComplete: true にする
	removeOnComplete: true,
	removeOnFail: defaultRemovePolicy.removeOnFail,
});
