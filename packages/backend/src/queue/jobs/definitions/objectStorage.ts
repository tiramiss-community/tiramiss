/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import { ObjectStorageFileJobData } from '@/queue/types.js';

const config = loadConfig();

/**
 * ObjectStorage Queue の定義。
 * オブジェクトストレージ関連の処理を行うためのキュー。
 */
export const objectStorageQueue = defineQueueForBullMQ(QUEUE.OBJECT_STORAGE, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.OBJECT_STORAGE),
	},
	workerOptions: {
		autorun: false,
		concurrency: 16,
		...baseWorkerOptions(config, QUEUE.OBJECT_STORAGE),
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

export const deleteFileJob = defineJob<ObjectStorageFileJobData>('deleteFile', {
	queue: objectStorageQueue,
	...defaultRemovePolicy,
});

export const cleanRemoteFilesJob = defineJob<Record<string, unknown>>('cleanRemoteFiles', {
	queue: objectStorageQueue,
	...defaultRemovePolicy,
});
