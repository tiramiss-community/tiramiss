/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type { NoteDeleteJobData } from '@/queue/types.js';

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

export const noteDeleteQueue = defineQueueForBullMQ(QUEUE.NOTE_DELETE, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.NOTE_DELETE),
	},
	workerOptions: {
		autorun: false,
		concurrency: 4,
		...baseWorkerOptions(config, QUEUE.NOTE_DELETE),
	},
}).build();

export const noteDeleteJob = defineJob<NoteDeleteJobData>('noteDelete', {
	queue: noteDeleteQueue,
	attempts: 2,
	...defaultRemovePolicy,
});
