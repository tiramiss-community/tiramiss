/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineJob } from '@mokurokujs/core';
import { defineQueueForBullMQ } from '@mokurokujs/bullmq-adapter';
import { loadConfig } from '@/config.js';
import { QUEUE } from '@/queue/const.js';
import { baseQueueOptions, baseWorkerOptions } from '@/queue/helper.js';

const config = loadConfig();

export const systemQueue = defineQueueForBullMQ(QUEUE.SYSTEM, {
	queueOptions: {
		...baseQueueOptions(config, QUEUE.SYSTEM),
	},
	workerOptions: {
		autorun: false,
		...baseWorkerOptions(config, QUEUE.SYSTEM),
	},
}).build();

export const tickChartsJob = defineJob<void>('tickCharts', {
	queue: systemQueue,
});

export const resyncChartsJob = defineJob<void>('resyncCharts', {
	queue: systemQueue,
});

export const cleanChartsJob = defineJob<void>('cleanCharts', {
	queue: systemQueue,
});

export const aggregateRetentionJob = defineJob<void>('aggregateRetention', {
	queue: systemQueue,
});

export const cleanJob = defineJob<void>('clean', {
	queue: systemQueue,
});

export const checkExpiredMutingsJob = defineJob<void>('checkExpiredMutings', {
	queue: systemQueue,
});

export const bakeBufferedReactionsJob = defineJob<void>('bakeBufferedReactions', {
	queue: systemQueue,
});

export const checkModeratorsActivityJob = defineJob<void>('checkModeratorsActivity', {
	queue: systemQueue,
});

export const cleanRemoteNotesJob = defineJob<Record<string, unknown>>('cleanRemoteNotes', {
	queue: systemQueue,
});
