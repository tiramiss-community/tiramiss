/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { defineJob } from '@mokurokujs/core';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';
import type {
	DbJobDataWithUser,
	DbExportFollowingData,
	DBExportAntennasData,
	DbUserImportJobData,
	DBAntennaImportJobData,
	DbUserImportToDbJobData,
	DbUserDeleteJobData,
} from '../../types.js';

const config = loadConfig();

/**
 * DB Queue の定義。
 * データベース関連の重い処理を行うためのキュー。
 */
export const dbQueue = defineQueueForBullMQ(QUEUE.DB, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.DB),
	},
	workerOptions: {
		autorun: false,
		...baseWorkerOptions(config, QUEUE.DB),
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

// ==================== Delete Jobs ====================

export const deleteDriveFilesJob = defineJob<DbJobDataWithUser>('deleteDriveFiles', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const deleteAccountJob = defineJob<DbUserDeleteJobData>('deleteAccount', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

// ==================== Export Jobs ====================

export const exportCustomEmojisJob = defineJob<DbJobDataWithUser>('exportCustomEmojis', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportNotesJob = defineJob<DbJobDataWithUser>('exportNotes', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportClipsJob = defineJob<DbJobDataWithUser>('exportClips', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportFavoritesJob = defineJob<DbJobDataWithUser>('exportFavorites', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportFollowingJob = defineJob<DbExportFollowingData>('exportFollowing', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportMutingJob = defineJob<DbJobDataWithUser>('exportMuting', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportBlockingJob = defineJob<DbJobDataWithUser>('exportBlocking', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportUserListsJob = defineJob<DbJobDataWithUser>('exportUserLists', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const exportAntennasJob = defineJob<DBExportAntennasData>('exportAntennas', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

// ==================== Import Jobs ====================

export const importFollowingJob = defineJob<DbUserImportJobData>('importFollowing', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importFollowingToDbJob = defineJob<DbUserImportToDbJobData>('importFollowingToDb', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importMutingJob = defineJob<DbUserImportJobData>('importMuting', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importBlockingJob = defineJob<DbUserImportJobData>('importBlocking', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importBlockingToDbJob = defineJob<DbUserImportToDbJobData>('importBlockingToDb', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importUserListsJob = defineJob<DbUserImportJobData>('importUserLists', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importCustomEmojisJob = defineJob<DbUserImportJobData>('importCustomEmojis', {
	queue: dbQueue,
	...defaultRemovePolicy,
});

export const importAntennasJob = defineJob<DBAntennaImportJobData>('importAntennas', {
	queue: dbQueue,
	...defaultRemovePolicy,
});
